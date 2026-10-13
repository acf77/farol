/** Parse electron-builder's latest-mac.yml without a YAML dependency. */

export interface UpdateFeed {
  version: string
  file: string
  /** Base64 SHA-512 of the zip; electron-builder writes it, `publish-local.mjs` does not. */
  sha512?: string
}

/** A top-level `key: value`; indented `files:` entries do not match. */
function field(yml: string, key: string): string | undefined {
  return new RegExp(`^${key}:\\s*['"]?(.+?)['"]?\\s*$`, 'm').exec(yml)?.[1]?.trim()
}

export function parseUpdateFeed(yml: string): UpdateFeed | null {
  const version = field(yml, 'version')
  const file = field(yml, 'path')
  if (!version || !file) return null
  const sha512 = field(yml, 'sha512')
  return { version, file, ...(sha512 ? { sha512 } : {}) }
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
