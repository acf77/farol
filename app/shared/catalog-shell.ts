/**
 * Detect when a managed Chat agent shells a pipeline step itself instead of
 * selecting that pipeline via FAROL_PIPELINES. Soft prompts are not enough —
 * Codex especially tends to re-run lint/test cmds and then opt out with [].
 */

export interface CatalogShellNode {
  type: string
  cmd?: string
}

export interface CatalogShellPipeline {
  id: string
  name: string
  nodes: CatalogShellNode[]
}

function normalizeCmd(cmd: string): string {
  return cmd.replace(/\s+/g, ' ').trim()
}

/** Unique shell step commands from the managed catalog (already normalized). */
export function catalogShellCommands(pipelines: CatalogShellPipeline[]): string[] {
  const cmds: string[] = []
  for (const pipeline of pipelines) {
    for (const node of pipeline.nodes) {
      if (node.type !== 'shell' || typeof node.cmd !== 'string') continue
      const cmd = normalizeCmd(node.cmd)
      if (cmd) cmds.push(cmd)
    }
  }
  return [...new Set(cmds)]
}

/** Tool card names that mean "ran a shell command" across Claude / Cursor / Codex. */
export function isShellToolName(name: string): boolean {
  const n = name.toLowerCase().replace(/[_-]/g, '')
  return (
    n === 'shell' ||
    n === 'bash' ||
    n === 'zsh' ||
    n === 'command' ||
    n === 'commandexecution' ||
    n === 'terminal' ||
    n === 'runterminalcmd' ||
    n === 'bashtoolcall' ||
    n === 'shelltoolcall'
  )
}

/**
 * Which catalog cmds appear in agent shell invocations.
 * Details may be truncated (ellipsis) by the stream parser — match both ways.
 */
export function matchedCatalogShells(invocations: string[], catalog: string[]): string[] {
  const hits: string[] = []
  for (const raw of invocations) {
    const inv = normalizeCmd(raw)
    if (!inv) continue
    const invBase = inv.replace(/…$/, '').trim()
    for (const cmd of catalog) {
      if (!cmd) continue
      if (
        inv === cmd ||
        inv.startsWith(`${cmd} `) ||
        invBase === cmd ||
        invBase.startsWith(`${cmd} `) ||
        (invBase.length >= 16 && cmd.startsWith(invBase)) ||
        inv.includes(cmd) ||
        invBase.includes(cmd)
      ) {
        hits.push(cmd)
      }
    }
  }
  return [...new Set(hits)]
}

/** Pipelines whose shell steps include any of the matched commands. */
export function pipelinesForCatalogCmds(
  pipelines: CatalogShellPipeline[],
  cmds: string[]
): CatalogShellPipeline[] {
  if (!cmds.length) return []
  const want = new Set(cmds)
  return pipelines.filter((pipeline) =>
    pipeline.nodes.some(
      (node) => node.type === 'shell' && typeof node.cmd === 'string' && want.has(normalizeCmd(node.cmd))
    )
  )
}
