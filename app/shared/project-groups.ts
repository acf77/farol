/** Group open projects that share a git worktree set. */

import type { GitInfo, Project } from './types'

export interface GroupedProject {
  project: Project
  branch: string
}

export interface ProjectGroup {
  /** Stable id — usually the primary worktree path. */
  id: string
  /** Repo folder name (primary checkout basename). */
  label: string
  projects: GroupedProject[]
}

export function trimSlashes(p: string): string {
  return p.replace(/[/\\]+$/, '')
}

export function shortPath(p: string): string {
  const parts = trimSlashes(p).split(/[/\\]/)
  return parts.slice(-2).join('/')
}

/** Case-folded identity for grouping worktrees. */
function normPath(p: string): string {
  return trimSlashes(p).toLowerCase()
}

function basename(p: string): string {
  const parts = trimSlashes(p).split(/[/\\]/)
  return parts[parts.length - 1] || p
}

function makeUnionFind() {
  const parent = new Map<string, string>()
  const find = (a: string): string => {
    const p = parent.get(a) ?? a
    if (p !== a) {
      const root = find(p)
      parent.set(a, root)
      return root
    }
    return a
  }
  return {
    init(a: string): void {
      parent.set(a, a)
    },
    find,
    union(a: string, b: string): void {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(ra, rb)
    }
  }
}

function linkWorktrees(
  projects: Project[],
  gitByPath: Record<string, GitInfo | undefined>,
  uf: ReturnType<typeof makeUnionFind>
): void {
  const byNorm = new Map(projects.map((p) => [normPath(p.path), p]))
  for (const p of projects) {
    for (const w of gitByPath[p.path]?.worktrees ?? []) {
      const wn = normPath(w.path)
      if (byNorm.has(wn)) uf.union(normPath(p.path), wn)
    }
  }
}

function groupFromMembers(
  members: Project[],
  gitByPath: Record<string, GitInfo | undefined>
): ProjectGroup {
  let primaryPath = members[0].path
  let label = members[0].name
  for (const m of members) {
    const trees = gitByPath[m.path]?.worktrees
    if (!trees?.length) continue
    primaryPath = trees[0].path
    label = basename(primaryPath)
    break
  }
  return {
    id: normPath(primaryPath),
    label,
    projects: members
      .map((project) => ({
        project,
        branch: gitByPath[project.path]?.branch || project.name
      }))
      .sort((a, b) => a.branch.localeCompare(b.branch))
  }
}

/**
 * Cluster open folders that belong to the same repo (linked via `git worktree
 * list`). Unrelated folders each become their own group.
 */
export function groupOpenProjects(
  projects: Project[],
  gitByPath: Record<string, GitInfo | undefined>
): ProjectGroup[] {
  if (!projects.length) return []

  const uf = makeUnionFind()
  for (const p of projects) uf.init(normPath(p.path))
  linkWorktrees(projects, gitByPath, uf)

  const buckets = new Map<string, Project[]>()
  for (const p of projects) {
    const root = uf.find(normPath(p.path))
    const list = buckets.get(root) ?? []
    list.push(p)
    buckets.set(root, list)
  }

  return [...buckets.values()]
    .map((members) => groupFromMembers(members, gitByPath))
    .sort((a, b) => a.label.localeCompare(b.label))
}
