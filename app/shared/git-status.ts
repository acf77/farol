/** Parse `git status --porcelain=v1` into structured file lists. */

import type {
  GitFileKind,
  GitHubInfo,
  GitStatus,
  GitStatusFile,
  MergeStrategy,
  PrCheck,
  PrCheckState,
  PrCheckSummary,
  PullRequest
} from './types'

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

function occupied(ch: string): boolean {
  return ch !== ' ' && ch !== '?'
}

function pushOnce<T>(seen: Set<string>, key: string, list: T[], item: T): void {
  if (seen.has(key)) return
  seen.add(key)
  list.push(item)
}

function bucketLine(
  parsed: { index: string; worktree: string; path: string },
  staged: GitStatusFile[],
  unstaged: GitStatusFile[],
  untracked: GitStatusFile[],
  conflicts: GitStatusFile[],
  seen: Set<string>
): void {
  const { index, worktree, path } = parsed
  const code = `${index}${worktree}`
  const kind = kindFrom(code)
  if (kind === 'conflict') {
    pushOnce(seen, path, conflicts, { path, kind, staged: occupied(index) })
    return
  }
  if (code === '??') {
    pushOnce(seen, path, untracked, { path, kind: 'untracked', staged: false })
    return
  }
  if (occupied(index)) pushOnce(seen, `s:${path}`, staged, { path, kind, staged: true })
  if (occupied(worktree)) pushOnce(seen, `u:${path}`, unstaged, { path, kind, staged: false })
}

/** Prefer `origin`, otherwise the first name from `git remote`. */
export function pickPushRemote(raw: string): string | undefined {
  const remotes = raw.split('\n').map((r) => r.trim()).filter(Boolean)
  return remotes.includes('origin') ? 'origin' : remotes[0]
}

/** Turn porcelain lines into staged / unstaged / untracked / conflict buckets. */
export function parseGitStatus(porcelain: string): Omit<GitStatus, 'ahead' | 'behind' | 'upstream' | 'remote'> {
  const staged: GitStatusFile[] = []
  const unstaged: GitStatusFile[] = []
  const untracked: GitStatusFile[] = []
  const conflicts: GitStatusFile[] = []
  const seen = new Set<string>()

  for (const raw of porcelain.split('\n')) {
    const parsed = parsePath(raw.trimEnd())
    if (!parsed) continue
    bucketLine(parsed, staged, unstaged, untracked, conflicts, seen)
  }

  const dirty = staged.length + unstaged.length + untracked.length + conflicts.length
  return { clean: dirty === 0, staged, unstaged, untracked, conflicts }
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

/** One row per file that may be sent to AI and committed, minus likely secrets. */
export function committableChanges(st: GitStatus): GitStatusFile[] {
  const seen = new Set<string>()
  return [...st.staged, ...st.unstaged, ...st.untracked].filter((file) => {
    if (seen.has(file.path) || isSecretPath(file.path)) return false
    seen.add(file.path)
    return true
  })
}

/** The same paths as `committableChanges`, plus the ones withheld as likely secrets. */
export function committableFiles(st: GitStatus): { files: string[]; skipped: string[] } {
  const paths = [...new Set([...st.staged, ...st.unstaged, ...st.untracked].map((f) => f.path))]
  return { files: paths.filter((p) => !isSecretPath(p)), skipped: paths.filter(isSecretPath) }
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
  if (!st.upstream) {
    if (!st.remote) return 'Add a git remote before pushing this branch.'
    if (st.ahead === 0) return 'Nothing to push — this branch has no unpublished commits.'
    return null
  }
  if (st.ahead === 0) return 'Nothing to push — branch is even with upstream.'
  return null
}

/** Why this branch cannot open a pull request yet, or null when it can. */
export function pullRequestBlockReason(st: GitStatus | null): string | null {
  if (!st) return 'Reading branch status…'
  if (st.conflicts.length) return 'Resolve merge conflicts before opening a pull request.'
  if (!st.upstream) return 'Push this branch to the remote before opening a pull request.'
  if (st.ahead > 0) return 'Push your latest commits before opening a pull request.'
  return null
}

export function conflictSignals(status: GitStatus | null, github: GitHubInfo | null) {
  const workingTree = (status?.conflicts.length ?? 0) > 0
  const baseMerge = status?.baseMerge
  const pr = github?.prs[0]
  const prConflicts = !!pr?.hasConflicts
  return {
    workingTree,
    baseMerge,
    pr,
    prConflicts,
    any: workingTree || prConflicts || !!baseMerge?.conflicts
  }
}

/** Branch whose conflicts the Resolve action should materialize. */
export function conflictMergeBase(
  status: GitStatus | null,
  github: GitHubInfo | null
): string | undefined {
  const pr = github?.prs[0]
  if (pr?.hasConflicts && pr.base) return pr.base
  if (status?.baseMerge?.conflicts) return status.baseMerge.base
  return pr?.base || status?.baseMerge?.base
}

/** Merge state against the base branch and the open pull request. */
export function conflictStatusItems(
  status: GitStatus | null,
  github: GitHubInfo | null
): { tone: 'conflict' | 'ok' | 'muted'; text: string }[] {
  const { workingTree, baseMerge, pr, prConflicts } = conflictSignals(status, github)
  const items: { tone: 'conflict' | 'ok' | 'muted'; text: string }[] = []
  if (workingTree) {
    items.push({
      tone: 'conflict',
      text: 'Merge conflicts in the working tree — resolve before committing.'
    })
  }
  if (baseMerge) {
    items.push({
      tone: baseMerge.conflicts ? 'conflict' : 'ok',
      text: baseMerge.conflicts
        ? `This branch has merge conflicts with ${baseMerge.base}.`
        : `No conflicts with ${baseMerge.base}.`
    })
  }
  if (pr) {
    items.push({
      tone: prConflicts ? 'conflict' : 'ok',
      text: prConflicts
        ? `Pull request #${pr.number} has merge conflicts${pr.base ? ` with ${pr.base}` : ''}.`
        : `Pull request #${pr.number} has no merge conflicts.`
    })
  } else if (github?.available) {
    items.push({ tone: 'muted', text: 'No open pull request from this branch.' })
  }
  return items
}

const MERGE_TREE_CONFLICT = /(?:^|\n)(?:CONFLICT(?: \([^)]+\))?: Merge conflict in |changed in both )(.+)$/gim

/** Paths named in `git merge-tree --write-tree` conflict output. */
export function parseMergeTreeConflictPaths(out: string): string[] {
  const files: string[] = []
  const seen = new Set<string>()
  for (const match of out.matchAll(MERGE_TREE_CONFLICT)) {
    const path = match[1]?.trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    files.push(path)
  }
  return files
}

/** Ask the chat agent to finish a merge that already has conflict markers. */
export function conflictResolvePrompt(opts: {
  pr?: number
  base: string
  files: string[]
}): string {
  const where = opts.pr ? `Pull request #${opts.pr}` : 'This branch'
  const listed = opts.files.length
    ? opts.files.map((file) => `- ${file}`).join('\n')
    : '- (inspect the working tree for conflict markers)'
  return [
    `${where} has merge conflicts with ${opts.base}. Conflict markers are in the working tree.`,
    `Resolve every conflict, keep this branch's intended behavior, and leave the files ready to commit.`,
    `Conflicted files:\n${listed}`
  ].join('\n\n')
}

const CHECK_COUNTS = {
  pending: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  neutral: 0
} as const satisfies Record<PrCheckState, number>

/** Aggregate check rows into counts and a required-check readiness state. */
export function summarizePrChecks(
  checks: PrCheck[],
  opts?: { requireAllWhenUnmarked?: boolean }
): PrCheckSummary {
  const counts = { ...CHECK_COUNTS }
  for (const check of checks) counts[check.state] += 1

  if (!checks.length) {
    return { state: 'none', ...counts, checks }
  }

  const marked = checks.filter((check) => check.required)
  const required = marked.length
    ? marked
    : opts?.requireAllWhenUnmarked === false
      ? []
      : checks.filter((check) => check.state !== 'skipped' && check.state !== 'neutral')

  if (!required.length) {
    return { state: 'passed', ...counts, checks }
  }
  if (required.some((check) => check.state === 'failed')) {
    return { state: 'failed', ...counts, checks }
  }
  if (required.some((check) => check.state === 'pending')) {
    return { state: 'pending', ...counts, checks }
  }
  return { state: 'passed', ...counts, checks }
}

/**
 * Why this pull request cannot be merged yet, or null when a chosen strategy
 * may proceed. Pass `strategy` only when the UI has an explicit selection —
 * an empty strategy always blocks so the user must pick one each time.
 */
export function mergePullRequestBlockReason(
  pr: PullRequest | undefined | null,
  strategy?: MergeStrategy | null
): string | null {
  if (!pr) return 'No open pull request from this branch.'
  if (pr.isDraft) return 'Mark the pull request as ready for review before merging.'
  if (pr.hasConflicts) {
    return pr.base
      ? `Resolve merge conflicts with ${pr.base} before merging.`
      : 'Resolve merge conflicts before merging.'
  }
  const checks = pr.checks
  if (!checks || checks.state === 'unavailable') {
    return 'GitHub Actions status is unavailable.'
  }
  if (checks.state === 'pending') return 'Wait for required checks to finish.'
  if (checks.state === 'failed') return 'Required checks are failing.'
  if (!strategy) return 'Choose a merge strategy.'
  return null
}
