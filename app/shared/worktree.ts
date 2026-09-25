/** Git worktree path helpers — pure, so they can be unit-tested. */

export interface WorktreeEntry {
  path: string
  /** Null when the worktree is detached. */
  branch: string | null
}

export function parseWorktreeList(raw: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let dir = ''
  let branch: string | null = null
  const flush = (): void => {
    if (dir) entries.push({ path: dir, branch })
    dir = ''
    branch = null
  }
  for (const line of raw.split('\n')) {
    const t = line.replace(/\r$/, '').trimEnd()
    if (!t) {
      flush()
      continue
    }
    if (t.startsWith('worktree ')) dir = t.slice('worktree '.length)
    else if (t.startsWith('branch ')) {
      const ref = t.slice('branch '.length)
      branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (t === 'detached') {
      branch = null
    }
  }
  flush()
  return entries
}

/** Git lists the primary checkout first — that is the shared pipeline home. */
export function primaryWorktreePath(entries: WorktreeEntry[]): string | null {
  return entries[0]?.path ?? null
}

/**
 * Basename of the primary checkout — used as the `repo` prefix in sibling worktree
 * folder names so creating from a linked worktree does not stack prefixes.
 */
export function primaryRepoFolderName(toplevel: string, entries: WorktreeEntry[]): string {
  const primary = primaryWorktreePath(entries)
  return baseName(primary ?? toplevel) || baseName(toplevel) || 'repo'
}

/**
 * Deepest worktree whose path contains `cwd` — the checkout that owns it, so a
 * chat opened in a subdirectory shares that checkout's state. Null when the
 * path sits outside every listed worktree.
 */
export function owningWorktree<T extends { path: string }>(cwd: string, worktrees: T[]): T | null {
  const target = cwd.replace(/[/\\]+$/, '')
  let best: T | null = null
  let bestLen = -1
  for (const worktree of worktrees) {
    const dir = worktree.path.replace(/[/\\]+$/, '')
    if (
      (target === dir || target.startsWith(dir + '/') || target.startsWith(dir + '\\')) &&
      dir.length > bestLen
    ) {
      best = worktree
      bestLen = dir.length
    }
  }
  return best
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
}

function joinPath(base: string, rel: string): string {
  const sep = base.includes('\\') ? '\\' : '/'
  return `${base.replace(/[/\\]+$/, '')}${sep}${rel.replace(/^[/\\]+/, '')}`
}

function baseName(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || ''
}

function dirName(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (idx <= 0) return trimmed.slice(0, idx + 1) || '.'
  return trimmed.slice(0, idx)
}

/**
 * Directory that owns `.farol/pipelines.json` for every checkout of this
 * repo. Linked worktrees read and write the primary checkout's file.
 */
export function pipelineStoreRoot(
  projectPath: string,
  worktrees: WorktreeEntry[],
  gitCommonDir?: string | null
): string {
  const primary = primaryWorktreePath(worktrees)
  if (primary) return primary
  if (gitCommonDir) {
    const abs = isAbsolutePath(gitCommonDir) ? gitCommonDir : joinPath(projectPath, gitCommonDir)
    if (baseName(abs) === '.git') return dirName(abs)
  }
  return projectPath
}

/**
 * Path from git's "already checked out / used by worktree at …" errors, so we
 * can reopen that folder instead of failing.
 */
export function parseAlreadyOpenPath(message: string): string | null {
  const m = /already (?:checked out|used by worktree) at (?:'([^']+)'|"([^"]+)"|(\S+))/i.exec(
    message
  )
  return (m?.[1] || m?.[2] || m?.[3] || '').trim() || null
}

/**
 * Reduce a name to one safe folder: separators become dashes, `..` is dropped
 * so nothing can climb out of the parent directory, and a leading dash (which
 * every CLI would read as a flag) is trimmed off.
 */
function folderSafe(s: string): string {
  return s
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[<>:"|?*]/g, '')
    .replace(/\.{2,}/g, '')
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
}

/**
 * Sibling folder name for a worktree, e.g. `allaboard365-feature-x`. A custom
 * name wins when the user typed one; otherwise it is derived from the branch.
 */
export function worktreeFolderName(repoName: string, branch: string, custom?: string): string {
  return folderSafe(custom ?? '') || `${repoName}-${folderSafe(branch) || 'branch'}`
}

/**
 * Why git would reject `name` as a branch, phrased for a form field. Mirrors
 * the rules in git-check-ref-format(1) that a person is likely to trip over —
 * git itself remains the authority, so creation can still fail.
 */
export function branchNameError(name: string): string | null {
  const n = name.trim()
  if (!n) return 'Enter a branch name'
  if (/\s/.test(n)) return 'No spaces'
  if (/[~^:?*[\\]/.test(n)) return 'No ~ ^ : ? * [ or backslash'
  if (/^[-.]/.test(n)) return 'Cannot start with - or .'
  if (n.startsWith('/') || n.endsWith('/') || n.includes('//')) return 'Misplaced /'
  if (n.endsWith('.') || n.endsWith('.lock')) return 'Cannot end with . or .lock'
  if (n.includes('..') || n.includes('@{')) return 'No .. or @{'
  if (n === '@') return '@ is reserved'
  return null
}

/** A request to open `branch` in its own working copy. */
export interface WorktreeRequest {
  branch: string
  /** Branch or ref to start from. Ignored when `branch` already exists. */
  base?: string
  /** Folder basename, created next to the repo. Defaults to `repo-branch`. */
  folder?: string
}
