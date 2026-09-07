/** Markers a scripted pipeline shell prints so we can see when a command ends. */

import { randomBytes } from 'crypto'

export const MARK_START = '\x01BFL'
export const MARK_END = '\x02'

export type ShellFamily = 'zsh' | 'bash' | 'fish' | 'posix' | 'powershell'

/** Opaque token so a step cannot forge completion by printing a fixed marker. */
export function sessionToken(): string {
  return randomBytes(8).toString('hex')
}

export function shellFamily(shell: string): ShellFamily {
  const name = (shell.split(/[\\/]/).pop() || '').toLowerCase()
  if (process.platform === 'win32') return 'powershell'
  if (name.includes('zsh')) return 'zsh'
  if (name.includes('bash')) return 'bash'
  if (name.includes('fish')) return 'fish'
  return 'posix'
}

/** Quote a command for `eval` inside bash/zsh/posix. */
export function quoteSh(cmd: string): string {
  return `'${cmd.replace(/'/g, `'\\''`)}'`
}

/**
 * Print `token:code:cwd` wrapped in markers. Uses $'…' so the bytes in the PTY
 * output match MARK_START / MARK_END, independent of the user's PROMPT.
 */
const PRINT_UNIX = `printf $'\\001BFL%s:%s:%s\\002'`

function unixRunFn(token: string): string {
  const t = quoteSh(token)
  return (
    `__bf_run() { if eval "$1"; then ${PRINT_UNIX} ${t} "0" "$PWD"; else ${PRINT_UNIX} ${t} "$?" "$PWD"; fi; }; ` +
    `${PRINT_UNIX} ${t} "0" "$PWD"`
  )
}

/**
 * Commands sent once the login shell is reading stdin. Fancy prompts
 * (oh-my-zsh, Starship, p10k) overwrite PS1, so we never wait on a prompt —
 * we define a helper and print a ready marker ourselves.
 */
export function initScript(family: ShellFamily, token: string): string {
  switch (family) {
    case 'zsh':
      return (
        `unsetopt zle 2>/dev/null; setopt no_errexit 2>/dev/null; ` +
        `stty -echo 2>/dev/null; PROMPT=''; RPROMPT=''; PS1=''; PS2=''; ` +
        unixRunFn(token) +
        '\n'
      )
    case 'bash':
    case 'posix':
      return (
        `set +e 2>/dev/null; stty -echo 2>/dev/null; PS1=''; PS2=''; ` + unixRunFn(token) + '\n'
      )
    case 'fish':
      return (
        `stty -echo 2>/dev/null; ` +
        `function __bf_run; eval $argv; printf \\x01BFL%s:%s:%s\\x02 ${quoteSh(token)} $status $PWD; end; ` +
        `printf \\x01BFL%s:%s:%s\\x02 ${quoteSh(token)} 0 $PWD\n`
      )
    case 'powershell':
      return (
        `$__bf_tok = ${JSON.stringify(token)}; ` +
        `function __bf_run($c) { try { Invoke-Expression $c; $ec = if ($?) { 0 } else { 1 } } catch { $ec = 1 }; ` +
        `[Console]::Write([char]1 + 'BFL' + $__bf_tok + ':' + $ec + ':' + $PWD.Path + [char]2) }; ` +
        `[Console]::Write([char]1 + 'BFL' + $__bf_tok + ':0:' + $PWD.Path + [char]2)\n`
      )
  }
}

export function execScript(family: ShellFamily, cmd: string): string {
  switch (family) {
    case 'fish':
      return `__bf_run ${quoteSh(cmd)}\n`
    case 'powershell':
      return `__bf_run ${JSON.stringify(cmd)}\n`
    default:
      return `__bf_run ${quoteSh(cmd)}\n`
  }
}

export function loginArgs(family: ShellFamily): string[] {
  return family === 'powershell' ? ['-NoLogo', '-NoExit'] : ['-il']
}

export interface ParsedMark {
  token: string
  code: number
  cwd: string
}

export interface FeedResult {
  text: string
  marks: ParsedMark[]
  rest: string
}

/** Longest suffix of `buf` that is also a prefix of `marker`. */
export function partialSuffix(buf: string, marker: string): number {
  const max = Math.min(buf.length, marker.length - 1)
  for (let n = max; n > 0; n--) if (buf.endsWith(marker.slice(0, n))) return n
  return 0
}

/** Pull complete markers out of a PTY chunk buffer. */
export function feedMarks(buf: string): FeedResult {
  let text = ''
  const marks: ParsedMark[] = []
  let rest = buf
  for (;;) {
    const i = rest.indexOf(MARK_START)
    if (i === -1) break
    const j = rest.indexOf(MARK_END, i)
    if (j === -1) {
      text += rest.slice(0, i)
      rest = rest.slice(i)
      return { text, marks, rest }
    }
    text += rest.slice(0, i)
    const payload = rest.slice(i + MARK_START.length, j)
    const parts = payload.split(':')
    // Expected: token:code:cwd — reject anything else as non-completion noise.
    if (parts.length >= 3 && parts[0]) {
      const token = parts[0]
      const code = parseInt(parts[1], 10)
      const cwd = parts.slice(2).join(':')
      if (Number.isFinite(code)) marks.push({ token, code, cwd })
    }
    rest = rest.slice(j + MARK_END.length)
  }
  const keep = partialSuffix(rest, MARK_START)
  text += rest.slice(0, rest.length - keep)
  rest = rest.slice(rest.length - keep)
  return { text, marks, rest }
}
