/** Stable prefix for process identifiers that share one Electron main process. */
export function repositoryRuntimePrefix(projectPath: string): string {
  const normalized = projectPath.replace(/[/\\]+$/, '')
  let hash = 2166136261
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `repo-${(hash >>> 0).toString(36)}:`
}

export function scopedRuntimeId(projectPath: string, id: string): string {
  const prefix = repositoryRuntimePrefix(projectPath)
  return id.startsWith(prefix) ? id : `${prefix}${id}`
}

export function unscopedRuntimeId(projectPath: string, id: string): string | null {
  const prefix = repositoryRuntimePrefix(projectPath)
  return id.startsWith(prefix) ? id.slice(prefix.length) : null
}

/** Runner slot kinds: UI Run, managed Chat, and MCP each get their own slot. */
const RUNTIME_PIPELINE_SLOT =
  /^(?:(repo-[^:]+:))?(pipeline|managed-pipeline|mcp-pipeline):(.+)$/

/**
 * Map any runner slot id to the managed-Chat catalog id used in FAROL_PIPELINES.
 *
 * Auto-fix hands a failure report into managed Chat, whose catalog only
 * accepts `managed-pipeline:` ids. Pasting a UI (`pipeline:`) or MCP
 * (`mcp-pipeline:`) slot makes `selectedPipelines` reject the marker and
 * validation never starts.
 */
export function managedCatalogPipelineId(runtimeId: string): string | undefined {
  const m = RUNTIME_PIPELINE_SLOT.exec(runtimeId)
  if (!m) return undefined
  const [, repoPrefix = '', , bare] = m
  if (!bare) return undefined
  return `${repoPrefix}managed-pipeline:${bare}`
}
