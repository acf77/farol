/** Parse `git status --porcelain=v1` into structured file lists. */

import type { GitFileKind, GitStatus, GitStatusFile } from './types'

const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

function kindFrom(code: string): GitFileKind {
  if (CONFLICT.has(code)) return 'conflict'
  const c = code.replace(/\s/g, '')
  if (c.includes('?')) return 'untracked'
  if (c.includes('A')) return 'added'
  if (c.includes('D')) return 'deleted'
  if (c.includes('R')) return 'renamed'
  return 'modified'
}

function parsePath(line: string): { index: string; worktree: string; path: string } | null {
  if (line.length < 4) return null
  const index = line[0] ?? ' '
  const worktree = line[1] ?? ' '
  let path = line.slice(3)
  // Renames: "R  old -> new" — keep the destination.
  const arrow = path.indexOf(' -> ')
  if (arrow >= 0) path = path.slice(arrow + 4)
  return { index, worktree, path }
}

/** Turn porcelain lines into staged / unstaged / untracked / conflict buckets. */
export function parseGitStatus(porcelain: string): Omit<GitStatus, 'ahead' | 'behind'> {
  const staged: GitStatusFile[] = []
  const unstaged: GitStatusFile[] = []
  const untracked: GitStatusFile[] = []
  const conflicts: GitStatusFile[] = []
  const seen = new Set<string>()

  for (const raw of porcelain.split('\n')) {
    const line = raw.trimEnd()
    if (!line) continue
    const parsed = parsePath(line)
    if (!parsed) continue
    const { index, worktree, path } = parsed
    const code = `${index}${worktree}`
    const kind = kindFrom(code)

    if (kind === 'conflict') {
      if (!seen.has(path)) {
        seen.add(path)
        conflicts.push({ path, kind, staged: index !== ' ' && index !== '?' })
      }
      continue
    }

    if (code === '??') {
      if (!seen.has(path)) {
        seen.add(path)
        untracked.push({ path, kind: 'untracked', staged: false })
      }
      continue
    }

    if (index !== ' ' && index !== '?') {
      if (!seen.has(`s:${path}`)) {
        seen.add(`s:${path}`)
        staged.push({ path, kind, staged: true })
      }
    }
    if (worktree !== ' ' && worktree !== '?') {
      if (!seen.has(`u:${path}`)) {
        seen.add(`u:${path}`)
        unstaged.push({ path, kind, staged: false })
      }
    }
  }

  const clean =
    staged.length === 0 &&
    unstaged.length === 0 &&
    untracked.length === 0 &&
    conflicts.length === 0

  return { clean, staged, unstaged, untracked, conflicts }
}

/** Parse `git rev-list --left-right --count @{u}...HEAD` output. */
export function parseAheadBehind(raw: string): { ahead: number; behind: number } {
  const parts = raw.trim().split(/\s+/)
  if (parts.length < 2) return { ahead: 0, behind: 0 }
  const behind = Number(parts[0]) || 0
  const ahead = Number(parts[1]) || 0
  return { ahead, behind }
}
