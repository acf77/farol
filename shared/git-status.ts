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

const SECRET_KEYS = new Set([
  'id_rsa',
  'id_ed25519',
  'id_dsa',
  'id_ecdsa',
  'credentials',
  'credentials.json',
  'secrets.json',
  'service-account.json',
  '.npmrc',
  '.envrc'
])
const SECRET_EXT = /\.(pem|key|p12|pfx|jks|kdbx|tfvars)$/

/** Untracked or pending files that should not be staged, sent to an AI CLI, or committed. */
export function isSecretPath(filePath: string): boolean {
  const name = (filePath.split(/[/\\]/).pop() ?? filePath).toLowerCase()
  if (name === '.env') return true
  if (name.startsWith('.env.') && name !== '.env.example' && name !== '.env.sample') return true
  return SECRET_KEYS.has(name) || SECRET_EXT.test(name)
}

/** Files an AI commit may include, minus secret-looking paths. */
export function committableFiles(st: GitStatus): { files: string[]; skipped: string[] } {
  const paths = [...new Set([...st.staged, ...st.unstaged, ...st.untracked].map((f) => f.path))]
  const files: string[] = []
  const skipped: string[] = []
  for (const p of paths) {
    if (isSecretPath(p)) skipped.push(p)
    else files.push(p)
  }
  return { files, skipped }
}

/** True when `files` is exactly the current committable set (order-insensitive). */
export function draftMatchesStatus(files: string[], st: GitStatus): boolean {
  const live = committableFiles(st).files
  if (files.length !== live.length) return false
  const set = new Set(files)
  return live.every((p) => set.has(p))
}

export function commitBlockReason(st: GitStatus): string | null {
  if (st.conflicts.length) return 'Resolve merge conflicts before committing.'
  if (st.clean) return 'Working tree is clean — nothing to commit.'
  if (!committableFiles(st).files.length) {
    return 'Only secret-looking files are left — they were not staged.'
  }
  return null
}

export function pushBlockReason(st: GitStatus): string | null {
  if (st.conflicts.length) return 'Resolve merge conflicts before pushing.'
  if (st.behind > 0) return 'Branch is behind upstream — pull before pushing.'
  if (st.ahead === 0) return 'Nothing to push — branch is even with upstream.'
  return null
}
