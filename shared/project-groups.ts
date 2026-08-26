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

function normPath(p: string): string {
  return p.replace(/[/\\]+$/, '').toLowerCase()
}

function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || p
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

  const byNorm = new Map(projects.map((p) => [normPath(p.path), p]))
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
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const p of projects) parent.set(normPath(p.path), normPath(p.path))

  for (const p of projects) {
    const trees = gitByPath[p.path]?.worktrees ?? []
    for (const w of trees) {
      const wn = normPath(w.path)
      if (byNorm.has(wn)) union(normPath(p.path), wn)
    }
  }

  const buckets = new Map<string, Project[]>()
  for (const p of projects) {
    const root = find(normPath(p.path))
    const list = buckets.get(root) ?? []
    list.push(p)
    buckets.set(root, list)
  }

  const groups: ProjectGroup[] = []
  for (const members of buckets.values()) {
    let primaryPath = members[0].path
    let label = members[0].name
    for (const m of members) {
      const trees = gitByPath[m.path]?.worktrees
      if (trees?.length) {
        primaryPath = trees[0].path
        label = basename(primaryPath)
        break
      }
    }

    const listed = members
      .map((project) => ({
        project,
        branch: gitByPath[project.path]?.branch || project.name
      }))
      .sort((a, b) => a.branch.localeCompare(b.branch))

    groups.push({
      id: normPath(primaryPath),
      label,
      projects: listed
    })
  }

  return groups.sort((a, b) => a.label.localeCompare(b.label))
}
