/** Parse electron-builder's latest-mac.yml without a YAML dependency. */

export interface UpdateFeed {
  version: string
  file: string
}

export function parseUpdateFeed(yml: string): UpdateFeed | null {
  const version = /^version:\s*['"]?(.+?)['"]?\s*$/m.exec(yml)?.[1]?.trim()
  const file = /^path:\s*['"]?(.+?)['"]?\s*$/m.exec(yml)?.[1]?.trim()
  if (!version || !file) return null
  return { version, file }
}

function parts(v: string): number[] {
  return v
    .split(/[.+-]/)
    .slice(0, 3)
    .map((n) => parseInt(n, 10) || 0)
}

/** True when `next` is a higher semver than `current` (major.minor.patch). */
export function versionAhead(next: string, current: string): boolean {
  const a = parts(next)
  const b = parts(current)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}
