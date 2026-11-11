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

/** PATH additions for a node that a login shell did not put on PATH. */
const NODE_PATH_SETUP = [
  'for d in "$HOME/.volta/bin" "$HOME/.local/bin" "$HOME/.bun/bin" /usr/local/bin /opt/homebrew/bin; do',
  '  [ -d "$d" ] && PATH="$PATH:$d"',
  'done',
  'if [ -d "$HOME/.nvm/versions/node" ]; then',
  '  for d in "$HOME"/.nvm/versions/node/*/bin; do PATH="$d:$PATH"; done',
  'fi',
  'export PATH'
].join('\n')

/** Where a given server build lives on the remote, relative to `$HOME`. */
export function serverDir(buildId: string): string {
  return `.farol-server/${buildId}`
}

/** Reports node, git, home, and whether this build is installed — as `FAROL_<KEY>=value` lines. */
export function probeScript(buildId: string): string {
  return [
    NODE_PATH_SETUP,
    'echo "FAROL_HOME=$HOME"',
    'echo "FAROL_NODE=$(command -v node || true)"',
    'echo "FAROL_NODE_VERSION=$(node -v 2>/dev/null || true)"',
    'echo "FAROL_GIT=$(command -v git || true)"',
    'echo "FAROL_OS=$(uname -s)"',
    `if [ -f "$HOME/${serverDir(buildId)}/.ready" ]; then echo FAROL_READY=1; fi`
  ].join('\n')
}

export interface ProbeResult {
  home: string
  node: string
  nodeVersion: string
  git: string
  os: string
  ready: boolean
}

export function parseProbe(stdout: string): ProbeResult {
  const values = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const m = /^FAROL_([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m) values.set(m[1], m[2].trim())
  }
  return {
    home: values.get('HOME') ?? '',
    node: values.get('NODE') ?? '',
    nodeVersion: values.get('NODE_VERSION') ?? '',
    git: values.get('GIT') ?? '',
    os: values.get('OS') ?? '',
    ready: values.get('READY') === '1'
  }
}

export const MIN_NODE_MAJOR = 20

/** Why this machine cannot run the Farol server, or null when it can. */
export function probeProblem(probe: ProbeResult): string | null {
  if (!probe.home) return 'The remote shell did not report a home directory.'
  if (!probe.node) {
    return `Node.js ${MIN_NODE_MAJOR} or newer is needed on the remote machine (install it, for example with nvm).`
  }
  const major = Number(/^v?(\d+)/.exec(probe.nodeVersion)?.[1] ?? NaN)
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    return `Node.js ${MIN_NODE_MAJOR} or newer is needed on the remote machine; it has ${probe.nodeVersion || 'an unknown version'}.`
  }
  if (!probe.git) return 'git is needed on the remote machine.'
  return null
}

/**
 * Unpacks the server (a tar.gz on stdin) and installs node-pty for terminal
 * panes. A failed install still leaves a working server — only terminal panes
 * need it — so it is logged and `.ready` is written either way.
 */
export function installScript(buildId: string): string {
  const dir = `"$HOME/${serverDir(buildId)}"`
  return [
    NODE_PATH_SETUP,
    'set -e',
    `rm -rf ${dir}.tmp`,
    `mkdir -p ${dir}.tmp`,
    `tar -xzf - -C ${dir}.tmp`,
    `cd ${dir}.tmp`,
    'if ! npm install --omit=dev --no-audit --no-fund > npm-install.log 2>&1; then echo "FAROL_PTY=0"; fi',
    'touch .ready',
    'cd "$HOME"',
    `rm -rf ${dir}`,
    `mv ${dir}.tmp ${dir}`,
    'echo FAROL_INSTALLED=1'
  ].join('\n')
}

/** Joins this connection to the server, starting it if it is not running. */
export function attachScript(buildId: string, node: string): string {
  return [NODE_PATH_SETUP, `exec ${shq(node)} "$HOME/${serverDir(buildId)}/farol-server.js" attach`].join('\n')
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
