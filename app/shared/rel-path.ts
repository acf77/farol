/** Reject `..`, absolute paths, and NUL. Empty is the project root. */
export function normalizeRelPath(rel: string): string | null {
  if (typeof rel !== 'string' || rel.includes('\0')) return null
  const posix = rel.replace(/\\/g, '/')
  if (posix.startsWith('/') || /^[A-Za-z]:\//.test(posix)) return null
  const parts: string[] = []
  for (const part of posix.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') return null
    parts.push(part)
  }
  return parts.join('/')
}
