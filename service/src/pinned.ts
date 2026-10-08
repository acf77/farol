import type { Pipeline } from '../shared/types'

/**
 * The commands a workspace may run: the shell steps of the pipelines that came
 * in its own snapshot, with each `${name}` filled by a single-quoted value — what
 * the desktop runner sends (`expandVars` with `quoteShellArg`). Anything else is
 * refused, so a token can start the project's own steps but is not a remote shell.
 */

const VAR_REF = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/
/** One `quoteShellArg` result: `'…'` where an inner quote is written `'\''`. */
const QUOTED = `'(?:[^']|'\\\\'')*'`

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function templatePattern(cmd: string): RegExp {
  return new RegExp(`^${cmd.split(VAR_REF).map(escape).join(QUOTED)}$`)
}

export function pinnedCommands(pipelines: Pipeline[]): (cmd: string) => boolean {
  const patterns = pipelines.flatMap((p) => p.nodes.filter((n) => n.type === 'shell').map((n) => templatePattern(n.cmd)))
  return (cmd) => patterns.some((pattern) => pattern.test(cmd))
}
