import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import {
  attachScript,
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

  it('quotes the node path in the attach script', () => {
    expect(attachScript('0.7.1-abc', "/opt/my node/bin/node")).toContain(`exec '/opt/my node/bin/node' "$HOME/.farol-server/0.7.1-abc/farol-server.js" attach`)
  })
})

describe('probe', () => {
  const ok = parseProbe(
    ['motd noise', 'FAROL_HOME=/home/ana', 'FAROL_NODE=/usr/bin/node', 'FAROL_NODE_VERSION=v22.3.0', 'FAROL_GIT=/usr/bin/git', 'FAROL_OS=Linux', 'FAROL_READY=1'].join('\n')
  )

  it('reads the marked lines and ignores the rest', () => {
    expect(ok).toEqual({ home: '/home/ana', node: '/usr/bin/node', nodeVersion: 'v22.3.0', git: '/usr/bin/git', os: 'Linux', ready: true })
    expect(probeProblem(ok)).toBeNull()
  })

  it('names what is missing', () => {
    expect(probeProblem({ ...ok, node: '' })).toMatch(/Node\.js 20/)
    expect(probeProblem({ ...ok, nodeVersion: 'v18.19.0' })).toMatch(/has v18\.19\.0/)
    expect(probeProblem({ ...ok, git: '' })).toMatch(/git/)
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
