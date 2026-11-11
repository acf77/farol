import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  attachScript,
  installPlan,
  packagesProblem,
  packagesScript,
  parseMachineConfig,
  parseProbe,
  probeProblem,
  remoteCommand,
  shq,
  sshArgs,
  sshDiagnostics
} from '../shared/machine'

describe('parseMachineConfig', () => {
  it('accepts a Tailscale IP or MagicDNS name and drops empty fields', () => {
    expect(parseMachineConfig({ host: ' 100.101.102.103 ', user: '', identityFile: '' })).toEqual({
      ok: true,
      config: { host: '100.101.102.103' }
    })
    expect(parseMachineConfig({ host: 'devbox.tail1234.ts.net', user: 'ana', port: '2222', identityFile: '~/.ssh/id_ed25519' })).toEqual({
      ok: true,
      config: { host: 'devbox.tail1234.ts.net', user: 'ana', port: 2222, identityFile: '~/.ssh/id_ed25519' }
    })
  })

  it('splits user@host typed into the host field, keeping an explicit user', () => {
    expect(parseMachineConfig({ host: 'ana@devbox' })).toEqual({ ok: true, config: { host: 'devbox', user: 'ana' } })
    expect(parseMachineConfig({ host: 'ana@devbox', user: 'bo' })).toEqual({ ok: true, config: { host: 'devbox', user: 'bo' } })
  })

  it('omits the default port', () => {
    expect(parseMachineConfig({ host: 'devbox', port: 22 })).toEqual({ ok: true, config: { host: 'devbox' } })
  })

  it('refuses anything ssh could read as an option or a second word', () => {
    expect(parseMachineConfig({ host: '-oProxyCommand=evil' }).ok).toBe(false)
    expect(parseMachineConfig({ host: 'devbox; rm -rf ~' }).ok).toBe(false)
    expect(parseMachineConfig({ host: 'devbox', user: '-l' }).ok).toBe(false)
    expect(parseMachineConfig({ host: 'devbox', port: 70000 }).ok).toBe(false)
    expect(parseMachineConfig({ host: '' }).ok).toBe(false)
    expect(parseMachineConfig(null).ok).toBe(false)
  })
})

describe('sshArgs', () => {
  it('never prompts, multiplexes, and ends with the destination', () => {
    const args = sshArgs({ host: 'devbox', user: 'ana', port: 2222, identityFile: '/k' }, '/tmp/farol-ssh-%C')
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('ControlPath=/tmp/farol-ssh-%C')
    expect(args.slice(-1)).toEqual(['ana@devbox'])
    expect(args.join(' ')).toContain('-p 2222')
    expect(args.join(' ')).toContain('-i /k -o IdentitiesOnly=yes')
  })
})

describe('remoteCommand', () => {
  it('runs the script in sh, through the login shell, with quotes intact', () => {
    const script = `echo "it's $((1 + 1))" && printf '%s\\n' 'a b'`
    // What sshd does: hand the command string to the user's shell.
    const out = execFileSync('/bin/sh', ['-c', remoteCommand(script)], {
      env: { ...process.env, SHELL: '/bin/sh' }
    }).toString()
    expect(out).toBe("it's 2\na b\n")
  })

  it('quotes single quotes', () => {
    expect(execFileSync('/bin/sh', ['-c', `printf %s ${shq("a'b c")}`]).toString()).toBe("a'b c")
  })

  it('runs the server on Farol\'s own Node.js, ahead of the login PATH', () => {
    const script = attachScript('0.7.1-abc', 'arm64')
    expect(script).toContain('PATH="$HOME/.farol-server/runtime/node-v22.23.4-linux-arm64/bin":$PATH')
    expect(script).toContain('exec node "$HOME/.farol-server/0.7.1-abc/farol-server.js" attach')
  })
})

describe('probe', () => {
  const lines = [
    'motd noise',
    'FAROL_HOME=/home/ana',
    'FAROL_OS=Linux',
    'FAROL_ARCH=x86_64',
    'FAROL_LIBC=glibc',
    'FAROL_GIT=/usr/bin/git',
    'FAROL_FETCH=1',
    'FAROL_ROOT=1',
    'FAROL_RUNTIME=arm64',
    'FAROL_RUNTIME=x64',
    'FAROL_READY=1'
  ]
  const ok = parseProbe(lines.join('\n'))

  it('reads the marked lines and ignores the rest', () => {
    expect(ok).toEqual({
      home: '/home/ana',
      os: 'Linux',
      machine: 'x86_64',
      libc: 'glibc',
      git: true,
      fetch: true,
      root: true,
      runtime: true,
      ready: true
    })
    expect(probeProblem(ok)).toBeNull()
  })

  it('only counts a runtime for this machine\'s CPU', () => {
    expect(parseProbe(lines.filter((l) => l !== 'FAROL_RUNTIME=x64').join('\n')).runtime).toBe(false)
  })

  it('accepts only Linux on x86_64 or arm64 with glibc', () => {
    expect(probeProblem({ ...ok, os: 'Darwin' })).toMatch(/Linux machines only; this one runs Darwin/)
    expect(probeProblem({ ...ok, machine: 'armv7l' })).toMatch(/x86_64 and arm64/)
    expect(probeProblem({ ...ok, machine: 'aarch64' })).toBeNull()
    expect(probeProblem({ ...ok, libc: 'musl' })).toMatch(/Alpine/)
  })

  it('plans only what is missing', () => {
    expect(installPlan(ok)).toEqual({ packages: [], node: false, server: false })
    expect(installPlan({ ...ok, git: false, fetch: false, runtime: false, ready: false })).toEqual({
      packages: ['git', 'curl', 'ca-certificates'],
      node: true,
      server: true
    })
    // curl only matters for downloading Node.js.
    expect(installPlan({ ...ok, fetch: false }).packages).toEqual([])
  })

  it('says what to run when it cannot install packages itself', () => {
    expect(packagesProblem(['git'], 'devbox', 10)).toMatch(/passwordless sudo.*sudo apt install git/)
    expect(packagesProblem(['git'], 'devbox', 11)).toMatch(/package manager/)
  })
})

describe('packagesScript', () => {
  it('installs with the machine\'s package manager, non-interactively', () => {
    const bin = mkdtempSync(join(tmpdir(), 'farol-pm-'))
    const log = join(bin, 'calls')
    writeFileSync(join(bin, 'apt-get'), `#!/bin/sh\necho "$@" >> '${log}'\n`)
    writeFileSync(join(bin, 'id'), '#!/bin/sh\necho 0\n')
    chmodSync(join(bin, 'apt-get'), 0o755)
    chmodSync(join(bin, 'id'), 0o755)
    const out = execFileSync('/bin/sh', ['-c', packagesScript(['git', 'curl'])], {
      env: { PATH: `${bin}:/usr/bin:/bin` }
    }).toString()
    expect(out).toContain('FAROL_PKGS=0')
    expect(readFileSync(log, 'utf8')).toBe('update -qq\ninstall -y -qq git curl\n')
  })

  it('reports no package manager', () => {
    const bin = mkdtempSync(join(tmpdir(), 'farol-pm-'))
    writeFileSync(join(bin, 'id'), '#!/bin/sh\necho 0\n')
    chmodSync(join(bin, 'id'), 0o755)
    const out = execFileSync('/bin/sh', ['-c', packagesScript(['git'])], { env: { PATH: bin } }).toString()
    expect(out).toContain('FAROL_PKGS=11')
  })
})

describe('sshDiagnostics', () => {
  it('explains the usual failures in words and keeps a Tailscale login link', () => {
    expect(sshDiagnostics('ana@devbox: Permission denied (publickey).').message).toMatch(/Tailscale SSH/)
    expect(sshDiagnostics('ssh: Could not resolve hostname devbox: Name or service not known').message).toMatch(/tailnet/)
    expect(
      sshDiagnostics('# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/abc123\n').authUrl
    ).toBe('https://login.tailscale.com/a/abc123')
  })
})
