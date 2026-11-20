import fs from 'fs'
import path from 'path'

/** Path confinement for checkouts; symlinks are resolved before compare. */

/** Whether `dir` is `root` or inside it (paths already resolved). */
export function isInside(root: string, dir: string): boolean {
  const rel = path.relative(root, dir)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** `p` with every symlink resolved, or undefined when it is not a path to something that exists. */
export async function realPath(p: unknown): Promise<string | undefined> {
  if (typeof p !== 'string' || !p) return undefined
  try {
    return await fs.promises.realpath(p)
  } catch {
    return undefined
  }
}

/** Resolved `dir` when it lies under a `roots` entry; use the returned path to run work. */
export async function confineTo(
  roots: readonly string[],
  dir: unknown
): Promise<{ dir: string; checkout: string } | undefined> {
  const real = await realPath(dir)
  if (!real) return undefined
  for (const checkout of roots) {
    const root = await realPath(checkout)
    if (root && isInside(root, real)) return { dir: real, checkout }
  }
  return undefined
}

/** Like `confineTo`, also searching linked worktrees from `worktreesOf`. */
export async function confineToProjects(
  projects: readonly string[],
  worktreesOf: (project: string) => Promise<readonly string[]>,
  dir: unknown
): Promise<{ dir: string; checkout: string } | undefined> {
  const own = await confineTo(projects, dir)
  if (own) return own
  for (const project of projects) {
    const hit = await confineTo(await worktreesOf(project), dir)
    if (hit) return hit
  }
  return undefined
}
