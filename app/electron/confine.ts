import fs from 'fs'
import path from 'path'

/**
 * Keeping a request inside the checkouts it may touch. Paths are compared by where they really
 * are, with every symlink resolved: a link inside a project that leads to another repository is
 * not inside the project, however its path is written.
 */

/** Whether `dir` is `root` or inside it. Resolve both first: this compares paths, it does not follow links. */
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

/**
 * Where `dir` really is, when that is one of `roots` or inside one; undefined otherwise. `dir`
 * is what a caller sent, so it may be anything. Run in the `dir` returned, not the one passed in,
 * so that what was checked is what runs. `checkout` is the entry of `roots` that holds it, as given.
 */
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

/**
 * `confineTo` across projects: where `dir` really is, when it is inside one of `projects` or
 * inside a linked worktree of one, which `worktreesOf` names. Every project's own folder is
 * tried before any worktree is asked for, so the usual case runs no git.
 */
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
