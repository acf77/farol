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
