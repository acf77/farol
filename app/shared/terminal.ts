/** Turning captured terminal bytes into text a person or an agent can read. */

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const ANSI_OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g')
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

export function stripAnsi(s: string): string {
  return s.replace(ANSI_OSC, '').replace(ANSI_CSI, '')
}

/**
 * Grow a string while keeping only the trailing `max` characters.
 * Used for live pipeline/agent buffers so a verbose run cannot OOM the process.
 */
export function appendTail(prev: string, chunk: string, max: number): string {
  if (max <= 0) return ''
  if (chunk.length >= max) return chunk.slice(-max)
  const next = prev + chunk
  return next.length > max ? next.slice(-max) : next
}

/**
 * Flatten captured PTY output to what the screen would actually show.
 *
 * A carriage return means "back to column 0", so anything before the last one
 * on a line was overwritten — progress bars and spinners collapse to their
 * final state. zsh also marks output that lacks a trailing newline by printing
 * `%`, padding to the width of the terminal, then a CR; that marker is the
 * shell talking to the screen, not the command's output, so it goes too.
 */
export function plainText(raw: string): string {
  return stripAnsi(raw)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const last = line.lastIndexOf('\r')
      const visible = last >= 0 ? line.slice(last + 1) : line
      return visible.replace(/[ \t]+$/, '')
    })
    .filter((line, i, all) => !(/^%\s*$/.test(line) && i < all.length - 1))
    .join('\n')
    .replace(/^%\s*$/, '')
}
