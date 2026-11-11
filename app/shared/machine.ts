/**
 * A **Remote machine** is a computer Farol works on over SSH — typically one
 * on the user's tailnet, reached by its Tailscale IP or MagicDNS name. The
 * desktop app keeps its window; projects, git, shells, pipelines and agents
 * all run on that machine, in a small Farol server the app installs there.
 *
 * Not to be confused with a **Remote pipeline** (shell steps in a throwaway
 * sandbox on the Run service).
 *
 * This file is the part both ends share: the wire frames, and the pure
 * helpers that turn what the user typed into SSH arguments and shell scripts.
 */

/** What the user gives Farol to reach a Remote machine. */
export interface MachineConfig {
  /** Tailscale IP (`100.x.y.z`), MagicDNS name (`devbox` / `devbox.tail1234.ts.net`), or any SSH host. */
  host: string
  /** SSH user; empty uses `~/.ssh/config` or the local user name. */
  user?: string
  port?: number
  /** Private key file; empty uses the SSH agent, `~/.ssh/config`, or Tailscale SSH. */
  identityFile?: string
}

export type MachineState = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface MachineStatus {
  state: MachineState
  config: MachineConfig | null
  /** Progress or the last error, in words for the user. */
  message?: string
  /** A link SSH asked the user to open (Tailscale SSH check mode). */
  authUrl?: string
  /** The remote user's home directory, once connected — a starting point for opening a project. */
  home?: string
}

/** Frames on the wire: one JSON object per line, in both directions. */
export type MachineFrame =
  | { t: 'call'; id: number; ch: string; args: unknown[] }
  | { t: 'ret'; id: number; ok: true; value: unknown }
  | { t: 'ret'; id: number; ok: false; error: string }
  | { t: 'ev'; ch: string; payload: unknown }
  | { t: 'hello'; version: string; home: string; pty: boolean }

// Hosts and users go on the ssh command line: allow only what DNS names,
// IPv4/IPv6 addresses and Unix user names use, and never a leading '-'
// (which ssh would read as an option).
const HOST_RE = /^[A-Za-z0-9_.:%[\]-]+$/
const USER_RE = /^[A-Za-z0-9_.-]+$/

/** Trims and checks what the user typed. A `user@host` in the host field is split. */
export function parseMachineConfig(
  input: unknown
): { ok: true; config: MachineConfig } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Enter a host.' }
  const raw = input as Record<string, unknown>
  let host = typeof raw.host === 'string' ? raw.host.trim() : ''
  let user = typeof raw.user === 'string' ? raw.user.trim() : ''
  const at = host.lastIndexOf('@')
  if (at > 0) {
    if (!user) user = host.slice(0, at)
    host = host.slice(at + 1)
  }
  if (!host) return { ok: false, error: 'Enter a host: a Tailscale IP or MagicDNS name.' }
  if (host.startsWith('-') || !HOST_RE.test(host)) return { ok: false, error: 'That host name has characters SSH does not accept.' }
  if (user && (user.startsWith('-') || !USER_RE.test(user))) return { ok: false, error: 'That user name has characters SSH does not accept.' }
  let port: number | undefined
  if (raw.port !== undefined && raw.port !== null && raw.port !== '') {
    const n = Number(raw.port)
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, error: 'Port must be a number from 1 to 65535.' }
    if (n !== 22) port = n
  }
  const identityFile = typeof raw.identityFile === 'string' ? raw.identityFile.trim() : ''
  return {
    ok: true,
    config: {
      host,
      ...(user ? { user } : {}),
      ...(port ? { port } : {}),
      ...(identityFile ? { identityFile } : {})
    }
  }
}

/** `user@host`, or the host alone. */
export function machineLabel(config: MachineConfig): string {
  return config.user ? `${config.user}@${config.host}` : config.host
}

/** Quote one word for a POSIX shell (and for fish, which reads `'\''` the same way). */
export function shq(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/**
 * Options shared by every ssh call. Never prompts (a GUI app has no terminal
 * to type a password into); multiplexes one TCP connection across calls;
 * trusts a host key the first time and refuses one that changes after.
 */
export function sshArgs(config: MachineConfig, controlPath: string): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPath}`,
    '-o', 'ControlPersist=120',
    ...(config.port ? ['-p', String(config.port)] : []),
    ...(config.identityFile ? ['-i', config.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
    machineLabel(config)
  ]
}

/**
 * The remote command for `script`. sshd hands the command to the user's own
 * shell, which may be fish; that shell only has to run `$SHELL -lc '…'`, so
 * the script itself always runs in `sh` with a login shell's PATH (where nvm,
 * volta, Homebrew and agent CLIs usually live).
 */
export function remoteCommand(script: string): string {
  return `exec $SHELL -lc ${shq(`exec /bin/sh -c ${shq(script)}`)}`
}

/**
 * The Node.js the Farol server runs on. Farol downloads its own copy into
 * `~/.farol-server/runtime` instead of relying on (or changing) the machine's,
 * so the terminal library's prebuilt binary always matches it.
 */
export const NODE_VERSION = 'v22.23.4'
const NODE_DIST = `https://nodejs.org/dist/${NODE_VERSION}`

export type MachineArch = 'x64' | 'arm64'

/** `node-v22…-linux-x64`: the release's directory name, and where it is unpacked. */
export function nodeDistName(arch: MachineArch): string {
  return `node-${NODE_VERSION}-linux-${arch}`
}

/** Where a given server build lives on the remote, relative to `$HOME`. */
export function serverDir(buildId: string): string {
  return `.farol-server/${buildId}`
}

function runtimeBin(arch: MachineArch): string {
  return `"$HOME/.farol-server/runtime/${nodeDistName(arch)}/bin"`
}

/**
 * `farol_pkgs base|build PKG…` installs system packages with the machine's
 * package manager: as root, or with passwordless sudo — there is no terminal
 * to type a password into. `build` maps to each distribution's compiler
 * toolchain. Exit 10: no root and no passwordless sudo. 11: unknown package
 * manager.
 */
const PKG_FUNCTION = `farol_pkgs() {
  kind="$1"; shift
  if [ "$(id -u)" = 0 ]; then S=""; elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then S="sudo -n"; else return 10; fi
  if command -v apt-get >/dev/null 2>&1; then
    [ "$kind" = build ] && set -- build-essential python3
    $S env DEBIAN_FRONTEND=noninteractive apt-get update -qq && $S env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  elif command -v dnf >/dev/null 2>&1; then
    [ "$kind" = build ] && set -- gcc-c++ make python3
    $S dnf install -y -q "$@"
  elif command -v yum >/dev/null 2>&1; then
    [ "$kind" = build ] && set -- gcc-c++ make python3
    $S yum install -y -q "$@"
  elif command -v zypper >/dev/null 2>&1; then
    [ "$kind" = build ] && set -- gcc-c++ make python3
    $S zypper --non-interactive install "$@"
  elif command -v pacman >/dev/null 2>&1; then
    [ "$kind" = build ] && set -- base-devel python
    $S pacman -Sy --noconfirm --needed "$@"
  elif command -v apk >/dev/null 2>&1; then
    [ "$kind" = build ] && set -- build-base python3 linux-headers
    $S apk add --no-cache "$@"
  else
    return 11
  fi
}`

/** Reports the machine as `FAROL_<KEY>=value` lines; anything else a login shell prints is ignored. */
export function probeScript(buildId: string): string {
  return [
    'echo "FAROL_HOME=$HOME"',
    'echo "FAROL_OS=$(uname -s)"',
    'echo "FAROL_ARCH=$(uname -m)"',
    'if ls /lib/ld-musl-* >/dev/null 2>&1; then echo FAROL_LIBC=musl; else echo FAROL_LIBC=glibc; fi',
    'echo "FAROL_GIT=$(command -v git || true)"',
    'if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then echo FAROL_FETCH=1; fi',
    'if [ "$(id -u)" = 0 ] || { command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; }; then echo FAROL_ROOT=1; fi',
    `for a in x64 arm64; do if [ -x "$HOME/.farol-server/runtime/${'node-' + NODE_VERSION}-linux-$a/bin/node" ]; then echo "FAROL_RUNTIME=$a"; fi; done`,
    `if [ -f "$HOME/${serverDir(buildId)}/.ready" ]; then echo FAROL_READY=1; fi`
  ].join('\n')
}

export interface ProbeResult {
  home: string
  /** `uname -s`: Linux, Darwin, … */
  os: string
  /** `uname -m`: x86_64, aarch64, … */
  machine: string
  libc: 'glibc' | 'musl'
  git: boolean
  /** curl or wget, to download Node.js. */
  fetch: boolean
  /** Root, or passwordless sudo: system packages can be installed. */
  root: boolean
  /** Farol's own Node.js is already unpacked. */
  runtime: boolean
  /** This server build is already installed. */
  ready: boolean
}

export function parseProbe(stdout: string): ProbeResult {
  const values = new Map<string, string[]>()
  for (const line of stdout.split('\n')) {
    const m = /^FAROL_([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m) values.set(m[1], [...(values.get(m[1]) ?? []), m[2].trim()])
  }
  const one = (key: string): string => values.get(key)?.[0] ?? ''
  const arch = machineArch(one('ARCH'))
  return {
    home: one('HOME'),
    os: one('OS'),
    machine: one('ARCH'),
    libc: one('LIBC') === 'musl' ? 'musl' : 'glibc',
    git: !!one('GIT'),
    fetch: one('FETCH') === '1',
    root: one('ROOT') === '1',
    runtime: !!arch && (values.get('RUNTIME') ?? []).includes(arch),
    ready: one('READY') === '1'
  }
}

/** Node.js's name for the CPU, or null for one Farol does not support. */
export function machineArch(unameM: string): MachineArch | null {
  if (unameM === 'x86_64' || unameM === 'amd64') return 'x64'
  if (unameM === 'aarch64' || unameM === 'arm64') return 'arm64'
  return null
}

/** Why Farol cannot use this machine at all, or null when it can. Only Linux on x64 or arm64 with glibc. */
export function probeProblem(probe: ProbeResult): string | null {
  if (!probe.home) return 'The remote shell did not report a home directory.'
  if (probe.os !== 'Linux') {
    return `Farol works with Linux machines only; this one runs ${probe.os || 'an unknown system'}.`
  }
  if (!machineArch(probe.machine)) {
    return `Farol supports x86_64 and arm64 Linux machines; this one is ${probe.machine || 'an unknown CPU'}.`
  }
  if (probe.libc === 'musl') {
    return 'Farol does not support musl-based Linux (such as Alpine) yet. Use a glibc distribution like Debian, Ubuntu or Fedora.'
  }
  return null
}

/** What has to be installed before the server can run. */
export interface InstallPlan {
  /** System packages (needs root or passwordless sudo). */
  packages: string[]
  /** Download Farol's own Node.js. */
  node: boolean
  /** Upload this build of the server. */
  server: boolean
}

export function installPlan(probe: ProbeResult): InstallPlan {
  const packages = [...(probe.git ? [] : ['git']), ...(probe.fetch || probe.runtime ? [] : ['curl', 'ca-certificates'])]
  return { packages, node: !probe.runtime, server: !probe.ready }
}

/** The words for a package install Farol cannot do itself. */
export function packagesProblem(packages: string[], host: string, code: number | null): string {
  const list = packages.join(' ')
  if (code === 10) {
    return `${host} needs ${list}, and Farol can only install packages as root or with passwordless sudo. Install ${packages.length > 1 ? 'them' : 'it'} there (for example \`sudo apt install ${list}\`) and connect again.`
  }
  if (code === 11) return `${host} needs ${list}, and Farol does not know its package manager. Install ${packages.length > 1 ? 'them' : 'it'} there and connect again.`
  return `Installing ${list} on ${host} failed.`
}

/** Installs system packages; ends with `FAROL_PKGS=0` on success or the failure code. */
export function packagesScript(packages: string[]): string {
  return [PKG_FUNCTION, `farol_pkgs base ${packages.map(shq).join(' ')}`, 'echo "FAROL_PKGS=$?"'].join('\n')
}

/** Downloads Farol's Node.js, checks it against the release's SHA-256 list, and unpacks it. */
export function nodeInstallScript(arch: MachineArch): string {
  const name = nodeDistName(arch)
  return [
    'set -e',
    'dest="$HOME/.farol-server/runtime"',
    'mkdir -p "$dest"',
    'tmp=$(mktemp -d "$dest/dl.XXXXXX")',
    'trap \'rm -rf "$tmp"\' EXIT',
    'cd "$tmp"',
    'fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -q "$1" -O "$2"; fi; }',
    `fetch ${shq(`${NODE_DIST}/${name}.tar.gz`)} node.tar.gz`,
    `fetch ${shq(`${NODE_DIST}/SHASUMS256.txt`)} SHASUMS256.txt`,
    `want=$(grep ' ${name}.tar.gz$' SHASUMS256.txt | cut -d' ' -f1)`,
    'got=$(sha256sum node.tar.gz | cut -d" " -f1)',
    'if [ -z "$want" ] || [ "$want" != "$got" ]; then echo "Node.js download did not match its checksum" >&2; exit 1; fi',
    'tar -xzf node.tar.gz',
    `rm -rf "$dest/${name}"`,
    `mv ${name} "$dest/${name}"`,
    'echo FAROL_NODE_INSTALLED=1'
  ].join('\n')
}

/**
 * Unpacks the server (a tar.gz on stdin) and runs `npm install` with Farol's
 * Node.js. The terminal library comes prebuilt for Linux; only if that fails
 * does npm compile it, and then Farol installs a compiler first when it can.
 * A server without it still runs — only terminals and pipeline steps need it
 * — so `.ready` is written either way and `FAROL_PTY=0` reports the miss.
 */
export function installScript(buildId: string, arch: MachineArch): string {
  const dir = `"$HOME/${serverDir(buildId)}"`
  return [
    PKG_FUNCTION,
    `PATH=${runtimeBin(arch)}:$PATH`,
    'export PATH',
    'set -e',
    `rm -rf ${dir}.tmp`,
    `mkdir -p ${dir}.tmp`,
    `tar -xzf - -C ${dir}.tmp`,
    `cd ${dir}.tmp`,
    'set +e',
    'npm install --omit=dev --no-audit --no-fund > npm-install.log 2>&1',
    'if [ $? -ne 0 ]; then',
    '  farol_pkgs build >> npm-install.log 2>&1 && npm install --omit=dev --no-audit --no-fund >> npm-install.log 2>&1 || echo FAROL_PTY=0',
    'fi',
    'set -e',
    'touch .ready',
    'cd "$HOME"',
    `rm -rf ${dir}`,
    `mv ${dir}.tmp ${dir}`,
    'echo FAROL_INSTALLED=1'
  ].join('\n')
}

/**
 * Joins this connection to the server, starting it if it is not running.
 * Farol's Node.js goes first on PATH; the login shell's PATH stays after it,
 * so agent CLIs installed there are still found.
 */
export function attachScript(buildId: string, arch: MachineArch): string {
  return [`PATH=${runtimeBin(arch)}:$PATH`, 'export PATH', `exec node "$HOME/${serverDir(buildId)}/farol-server.js" attach`].join('\n')
}

/** Lines of SSH's stderr worth showing: the last non-empty one, and any login URL. */
export function sshDiagnostics(stderr: string): { message: string; authUrl?: string } {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
  const authUrl = /https:\/\/\S+/.exec(stderr)?.[0]
  const last = lines[lines.length - 1] ?? ''
  if (/Permission denied/i.test(last)) {
    return { message: `SSH refused the login: ${last}. Check the user and SSH key, or enable Tailscale SSH on that machine.`, authUrl }
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(last)) {
    return { message: `Could not find that host: ${last}. Is this computer on the tailnet?`, authUrl }
  }
  if (/timed out|No route to host|Connection refused/i.test(last)) {
    return { message: `Could not reach the host: ${last}. Check that both machines are online in Tailscale.`, authUrl }
  }
  return { message: last, authUrl }
}
