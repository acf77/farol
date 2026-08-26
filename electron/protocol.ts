/** Markers a scripted pipeline shell prints so we can see when a command ends. */

export const MARK_START = '\x01BFL'
export const MARK_END = '\x02'

export type ShellFamily = 'zsh' | 'bash' | 'fish' | 'posix' | 'powershell'

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
 * Print `code:cwd` wrapped in markers. Uses $'…' so the bytes in the PTY
 * output match MARK_START / MARK_END, independent of the user's PROMPT.
 */
const PRINT_UNIX = `printf $'\\001BFL%s:%s\\002'`

function unixRunFn(): string {
  return (
    `__bf_run() { if eval "$1"; then ${PRINT_UNIX} "0" "$PWD"; else ${PRINT_UNIX} "$?" "$PWD"; fi; }; ` +
    `${PRINT_UNIX} "0" "$PWD"`
  )
}

/**
 * Commands sent once the login shell is reading stdin. Fancy prompts
 * (oh-my-zsh, Starship, p10k) overwrite PS1, so we never wait on a prompt —
 * we define a helper and print a ready marker ourselves.
 */
export function initScript(family: ShellFamily): string {
  switch (family) {
    case 'zsh':
      return (
        `unsetopt zle 2>/dev/null; setopt no_errexit 2>/dev/null; ` +
        `stty -echo 2>/dev/null; PROMPT=''; RPROMPT=''; PS1=''; PS2=''; ` +
        unixRunFn() +
        '\n'
      )
    case 'bash':
    case 'posix':
      return (
        `set +e 2>/dev/null; stty -echo 2>/dev/null; PS1=''; PS2=''; ` + unixRunFn() + '\n'
      )
    case 'fish':
      return (
        `stty -echo 2>/dev/null; ` +
        `function __bf_run; eval $argv; printf \\x01BFL%s:%s\\x02 $status $PWD; end; ` +
        `printf \\x01BFL%s:%s\\x02 0 $PWD\n`
      )
    case 'powershell':
      return (
        `function __bf_run($c) { Invoke-Expression $c; ` +
        `$ec = if ($?) { 0 } else { 1 }; ` +
        `[Console]::Write([char]1 + 'BFL' + $ec + ':' + $PWD.Path + [char]2) }; ` +
        `[Console]::Write([char]1 + 'BFL0:' + $PWD.Path + [char]2)\n`
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
    const sep = payload.indexOf(':')
    const code = parseInt(sep === -1 ? payload : payload.slice(0, sep), 10)
    const cwd = sep === -1 ? '' : payload.slice(sep + 1)
    marks.push({ code: Number.isFinite(code) ? code : 0, cwd })
    rest = rest.slice(j + MARK_END.length)
  }
  const keep = partialSuffix(rest, MARK_START)
  text += rest.slice(0, rest.length - keep)
  rest = rest.slice(rest.length - keep)
  return { text, marks, rest }
}
