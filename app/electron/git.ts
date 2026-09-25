import { execCli } from './exec-cli'
import fs from 'fs'
import path from 'path'
import { runAiOnce } from './ai-oneshot'
import {
  activeHooks,
  commitBlockReason,
  conflictMergeBase,
  conflictResolvePrompt,
  isSecretPath,
  parseAheadBehind,
  parseGitStatus,
  parseMergeTreeConflictPaths,
  pickPushRemote,
  pushBlockReason,
  committableFiles
} from '../shared/git-status'
import type {
  AiProvider,
  GitCommit,
  GitHookInfo,
  GitHookRun,
  GitHubInfo,
  GitInfo,
  GitStatus
} from '../shared/types'
import { githubInfo } from './github'
import type { WorktreeRequest } from '../shared/worktree'
import {
  parseAlreadyOpenPath,
  parseWorktreeList,
  pipelineStoreRoot,
  primaryRepoFolderName,
  worktreeFolderName,
  type WorktreeEntry
} from '../shared/worktree'

/**
 * Real git, read through the CLI. Plain `execFile` rather than a PTY: this is
 * data for the UI, not something the user watches scroll by.
 */

function git(
  cwd: string,
  args: string[],
  timeout = 10_000
): Promise<{ code: number; out: string; err: string }> {
  return execCli('git', cwd, args, timeout)
}

function cliFirstLine(res: { out: string; err: string }): string {
  return (res.err || res.out).trim().split('\n').filter(Boolean)[0] ?? ''
}

function cliLastLine(res: { out: string; err: string }): string {
  const lines = (res.err || res.out).trim().split('\n').filter(Boolean)
  return lines.length ? lines[lines.length - 1]! : ''
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  const res = await git(cwd, ['show-ref', '--verify', '--quiet', ref])
  return res.code === 0
}

export async function info(cwd: string): Promise<GitInfo> {
  const [inside, bareRes] = await Promise.all([
    git(cwd, ['rev-parse', '--is-inside-work-tree']),
    git(cwd, ['rev-parse', '--is-bare-repository'])
  ])
  const bare = bareRes.code === 0 && bareRes.out.trim() === 'true'
  const inWorkTree = inside.code === 0 && inside.out.trim() === 'true'
  if (!inWorkTree && !bare) {
    return { isRepo: false, branch: '', branches: [] }
  }

  const [head, list, remoteList, trees] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['branch', '--format=%(refname:short)', '--sort=-committerdate']),
    git(cwd, ['branch', '-r', '--format=%(refname:short)', '--sort=-committerdate']),
    git(cwd, ['worktree', 'list', '--porcelain'])
  ])

  // Keep detached worktrees too: they are still checkouts a project can open into,
  // so todo sharing must resolve them to their root.
  const worktrees = parseWorktreeList(trees.out)

  const branch = head.out.trim()
  const branches = list.out
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
  const local = new Set(branches)
  // `origin/HEAD` is a symref alias — and `%(refname:short)` renders it as the
  // bare remote name, so require a `remote/branch` shape. A remote branch that
  // already exists locally adds nothing to a "start from…" list either.
  const remotes = remoteList.out
    .split('\n')
    .map((b) => b.trim())
    .filter((b) => b.includes('/') && !b.endsWith('/HEAD') && !local.has(b.replace(/^[^/]+\//, '')))

  // Detached HEAD reports "HEAD"; show the short sha instead.
  if (branch === 'HEAD') {
    const sha = await git(cwd, ['rev-parse', '--short', 'HEAD'])
    return {
      isRepo: true,
      branch: sha.out.trim() || 'detached',
      branches,
      remotes,
      detached: true,
      bare,
      worktrees
    }
  }

  return {
    isRepo: true,
    branch,
    branches: branches.includes(branch) ? branches : [branch, ...branches],
    remotes,
    bare,
    worktrees
  }
}

export async function checkout(cwd: string, branch: string): Promise<{ ok: boolean; message: string }> {
  const bare = await git(cwd, ['rev-parse', '--is-bare-repository'])
  if (bare.code === 0 && bare.out.trim() === 'true') {
    return {
      ok: false,
      message: 'Bare repository — open a branch worktree as a project instead of checking out here'
    }
  }
  const res = await git(cwd, ['checkout', branch])
  // git writes "Switched to branch 'x'" to stderr, so use it for both outcomes.
  const message = cliFirstLine(res)
  return { ok: res.code === 0, message }
}

/**
 * Resolve a user-supplied base into a ref git can start a branch from, and say
 * whether it is remote-tracking (which earns `--track`). `staging` matches a
 * local branch first, then `origin/staging`.
 */
async function resolveBase(
  cwd: string,
  base: string
): Promise<{ ref: string; remote: boolean } | null> {
  const b = base.trim()
  if (!b) return null
  if (await refExists(cwd, `refs/heads/${b}`)) return { ref: b, remote: false }
  if (await refExists(cwd, `refs/remotes/${b}`)) return { ref: b, remote: true }
  if (await refExists(cwd, `refs/remotes/origin/${b}`)) return { ref: `origin/${b}`, remote: true }
  return null
}

/**
 * Ref to merge when reproducing a PR/base conflict. Prefer `origin/<base>` so a
 * stale local branch of the same name cannot hide the conflicts GitHub reported.
 */
async function resolveConflictSource(cwd: string, base: string): Promise<string | null> {
  const b = base.trim()
  if (!b) return null
  if (await refExists(cwd, `refs/remotes/origin/${b}`)) return `origin/${b}`
  const from = await resolveBase(cwd, b)
  return from?.ref ?? null
}

type WorktreeResult = {
  ok: boolean
  path?: string
  branch?: string
  reused?: boolean
  message: string
}

async function resolveWorktreeRoot(
  cwd: string
): Promise<{ toplevel: string; bare: boolean } | { message: string }> {
  const [top, bareRes] = await Promise.all([
    git(cwd, ['rev-parse', '--show-toplevel']),
    git(cwd, ['rev-parse', '--is-bare-repository'])
  ])
  const bare = bareRes.code === 0 && bareRes.out.trim() === 'true'
  // Bare hubs have no work-tree toplevel; sibling worktrees still live next to `cwd`.
  const toplevel = top.code === 0 ? top.out.trim() : bare ? path.resolve(cwd) : ''
  if (!toplevel) {
    return { message: (top.err || top.out).trim() || 'not a git repository' }
  }
  return { toplevel, bare }
}

async function reuseExistingWorktree(
  cwd: string,
  name: string,
  toplevel: string,
  bare: boolean,
  trees: WorktreeEntry[]
): Promise<WorktreeResult | null> {
  const existing = trees.find((t) => t.branch === name)
  if (existing && fs.existsSync(existing.path)) {
    return { ok: true, path: existing.path, branch: name, reused: true, message: '' }
  }

  const head = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  // Never hand the bare hub back as a checkout — it cannot be used as a project cwd.
  if (!bare && head.out.trim() === name) {
    return { ok: true, path: toplevel, branch: name, reused: true, message: '' }
  }
  return null
}

async function resolveWorktreeDest(
  toplevel: string,
  name: string,
  folder: string | undefined,
  repoFolder: string
): Promise<{ dest: string } | WorktreeResult> {
  const destBase = path.join(
    path.dirname(toplevel),
    worktreeFolderName(repoFolder, name, folder)
  )
  if (fs.existsSync(destBase)) {
    const at = await git(destBase, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (at.code === 0 && at.out.trim() === name) {
      return { ok: true, path: destBase, branch: name, reused: true, message: '' }
    }
    // A folder the user named explicitly is not something to silently sidestep.
    if (folder?.trim()) {
      return { ok: false, message: `${path.basename(destBase)} already exists` }
    }
  }

  let dest = destBase
  for (let n = 2; fs.existsSync(dest); n++) dest = `${destBase}-${n}`
  return { dest }
}

async function buildWorktreeArgs(
  cwd: string,
  name: string,
  dest: string,
  base: string | undefined
): Promise<{ args: string[] } | { message: string }> {
  if (await refExists(cwd, `refs/heads/${name}`)) {
    return { args: ['worktree', 'add', dest, name] }
  }
  if (base?.trim()) {
    const from = await resolveBase(cwd, base)
    if (!from) return { message: `unknown branch ${base.trim()}` }
    return {
      args: from.remote
        ? ['worktree', 'add', '--track', '-b', name, dest, from.ref]
        : ['worktree', 'add', '-b', name, dest, from.ref]
    }
  }
  if (await refExists(cwd, `refs/remotes/origin/${name}`)) {
    return { args: ['worktree', 'add', '--track', '-b', name, dest, `origin/${name}`] }
  }
  return { args: ['worktree', 'add', '-b', name, dest] }
}

/**
 * Open `branch` in a separate working copy so the project's current checkout
 * is left alone. Reuses an existing worktree for that branch when there is
 * one; otherwise creates a sibling folder (`repo-branch-name`, or `folder`).
 *
 * `base` only applies when the branch is being created — an existing branch is
 * checked out as it stands rather than being silently reset onto something else.
 */
export async function addWorktree(cwd: string, req: WorktreeRequest): Promise<WorktreeResult> {
  const name = req.branch.trim()
  if (!name) return { ok: false, message: 'Enter a branch name' }

  const root = await resolveWorktreeRoot(cwd)
  if ('message' in root) return { ok: false, message: root.message }

  const listed = await git(cwd, ['worktree', 'list', '--porcelain'])
  const trees = parseWorktreeList(listed.out)
  const repoFolder = primaryRepoFolderName(root.toplevel, trees)

  const reused = await reuseExistingWorktree(cwd, name, root.toplevel, root.bare, trees)
  if (reused) return reused

  const destOrReuse = await resolveWorktreeDest(root.toplevel, name, req.folder, repoFolder)
  if ('ok' in destOrReuse) return destOrReuse

  const built = await buildWorktreeArgs(cwd, name, destOrReuse.dest, req.base)
  if ('message' in built) return { ok: false, message: built.message }

  const res = await git(cwd, built.args, 120_000)
  if (res.code !== 0) {
    const message = cliLastLine(res) || 'could not create worktree'
    const open = parseAlreadyOpenPath(message)
    if (open && fs.existsSync(open)) {
      return { ok: true, path: open, branch: name, reused: true, message: '' }
    }
    return { ok: false, message }
  }
  return { ok: true, path: destOrReuse.dest, branch: name, message: '' }
}

async function mergeTree(
  cwd: string,
  ref: string
): Promise<{ code: number; out: string }> {
  const tree = await git(cwd, ['merge-tree', '--write-tree', ref, 'HEAD'])
  return { code: tree.code, out: `${tree.out}\n${tree.err}` }
}

/** Paths that would conflict if `base` were merged into HEAD. */
async function mergeConflictPaths(cwd: string, base: string): Promise<string[]> {
  const ref = await resolveConflictSource(cwd, base)
  if (!ref) return []
  const tree = await mergeTree(cwd, ref)
  if (tree.code !== 1) return []
  return parseMergeTreeConflictPaths(tree.out)
}

/** Whether merging HEAD into `staging` would conflict. Skipped when that ref is missing. */
export async function mergeBaseConflicts(
  cwd: string
): Promise<{ base: string; conflicts: boolean } | undefined> {
  const head = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = head.out.trim()
  if (!branch || branch === 'HEAD' || branch === 'staging') return undefined

  const from = await resolveBase(cwd, 'staging')
  if (!from) return undefined
  const tree = await mergeTree(cwd, from.ref)
  if (tree.code === 0) return { base: 'staging', conflicts: false }
  if (tree.code === 1) return { base: 'staging', conflicts: true }
  return undefined
}

/** GitHub PR plus conflicted paths from a local merge-tree against the PR base. */
export async function githubStatus(cwd: string): Promise<GitHubInfo> {
  const info = await githubInfo(cwd)
  const pr = info.prs[0]
  if (!pr?.hasConflicts || !pr.base) return info
  const files = await mergeConflictPaths(cwd, pr.base)
  return files.length ? { ...info, conflictFiles: files } : info
}

const CONFLICTS_IN_TREE = 'Conflicts are already in the working tree.'

/** Merge `base` into HEAD so conflict markers exist for the agent to edit. */
export async function mergeForConflicts(
  cwd: string,
  base?: string
): Promise<{ ok: boolean; message: string; files: string[] }> {
  const st = await status(cwd)
  if (st.conflicts.length) {
    return {
      ok: true,
      message: CONFLICTS_IN_TREE,
      files: st.conflicts.map((file) => file.path)
    }
  }
  if (!st.clean) {
    return {
      ok: false,
      message: 'Commit or stash local changes before merging the pull request base.',
      files: []
    }
  }
  if (!base) {
    return { ok: false, message: 'Could not determine the branch to merge.', files: [] }
  }
  await git(cwd, ['fetch', 'origin', base], 120_000)
  const from = await resolveConflictSource(cwd, base)
  if (!from) {
    return { ok: false, message: `Could not find ${base} to merge.`, files: [] }
  }
  const res = await git(cwd, ['merge', '--no-commit', '--no-ff', from], 120_000)
  const next = await status(cwd)
  if (next.conflicts.length) {
    return {
      ok: true,
      message: `Merged ${base} with conflicts.`,
      files: next.conflicts.map((file) => file.path)
    }
  }
  await git(cwd, ['merge', '--abort'])
  if (res.code === 0) {
    return { ok: false, message: `Merge of ${base} completed without conflicts.`, files: [] }
  }
  return { ok: false, message: cliFirstLine(res) || `Could not merge ${base}.`, files: [] }
}

/** Materialize PR/base conflicts and return the prompt to send to Chat. */
export async function bringPrConflicts(
  cwd: string
): Promise<{ ok: boolean; message: string; prompt?: string }> {
  const [gh, st] = await Promise.all([githubInfo(cwd), status(cwd)])
  const pr = gh.prs[0]
  const base = conflictMergeBase(st, gh)
  if (!st.conflicts.length && !pr?.hasConflicts && !st.baseMerge?.conflicts) {
    return { ok: false, message: 'No pull request conflicts to resolve.' }
  }
  const merged = await mergeForConflicts(cwd, base)
  if (!merged.ok) return { ok: false, message: merged.message }
  return {
    ok: true,
    message: merged.message,
    prompt: conflictResolvePrompt({
      pr: pr?.number,
      base: base || 'the other branch',
      files: merged.files
    })
  }
}

/** Hooks installed for `cwd`'s repo — respects `core.hooksPath`, skips `.sample` templates. */
export async function hooksInfo(cwd: string): Promise<GitHookInfo[]> {
  const dir = await git(cwd, ['rev-parse', '--git-path', 'hooks'])
  if (dir.code !== 0) return []
  const hooksPath = path.resolve(cwd, dir.out.trim())

  let entries: string[]
  try {
    entries = fs.readdirSync(hooksPath)
  } catch {
    return []
  }

  return entries
    .filter((name) => !name.startsWith('.') && !name.endsWith('.sample'))
    .map((name) => {
      const full = path.join(hooksPath, name)
      let enabled: boolean
      try {
        fs.accessSync(full, fs.constants.X_OK)
        enabled = fs.statSync(full).isFile()
      } catch {
        enabled = false
      }
      return { name, path: full, enabled }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Hooks that could have caused a failed commit/push, with the raw output they (or git) printed. */
async function hookRunFor(
  cwd: string,
  kind: 'commit' | 'push',
  output: string
): Promise<GitHookRun | undefined> {
  const hooks = activeHooks(await hooksInfo(cwd), kind)
  return hooks.length ? { hooks: hooks.map((hook) => hook.name), output } : undefined
}

export async function status(cwd: string): Promise<GitStatus> {
  const [porcelain, tracking, baseMerge, remotes, unpublished] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1']),
    git(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    mergeBaseConflicts(cwd),
    git(cwd, ['remote']),
    git(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])
  ])
  const parsed = parseGitStatus(porcelain.out)
  const remote = pickPushRemote(remotes.out)
  const upstream = tracking.code === 0
  const { ahead, behind } = upstream
    ? parseAheadBehind(tracking.out)
    : { ahead: unpublished.code === 0 ? Number(unpublished.out.trim()) || 0 : 0, behind: 0 }
  return {
    ...parsed,
    ahead,
    behind,
    upstream,
    ...(remote ? { remote } : {}),
    ...(baseMerge ? { baseMerge } : {})
  }
}

/** Parse `git log --format=%h\\t%s\\t%an\\t%cr` lines. */
export function parseCommitLog(out: string): GitCommit[] {
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [hash, subject, author, when] = line.split('\t')
      if (!hash || !subject) return []
      return [{ hash, subject, author: author || '', when: when || '' }]
    })
}

/** Latest commits on the current branch, newest first. */
export async function recentCommits(cwd: string, limit = 5): Promise<GitCommit[]> {
  const res = await git(cwd, ['log', `-n${limit}`, '--format=%h\t%s\t%an\t%cr'])
  return res.code === 0 ? parseCommitLog(res.out) : []
}

async function stageFiles(cwd: string, files: string[]): Promise<{ ok: boolean; message: string }> {
  if (!files.length) return { ok: false, message: 'Nothing safe to commit' }
  const res = await git(cwd, ['add', '--', ...files])
  return { ok: res.code === 0, message: cliFirstLine(res) }
}

async function unstageFiles(cwd: string, files: string[]): Promise<{ ok: boolean; message: string }> {
  if (!files.length) return { ok: true, message: '' }
  // No revision argument: `reset` defaults to HEAD, and falls back to the empty
  // tree on an unborn HEAD (a repo with no commits).
  const res = await git(cwd, ['reset', '-q', '--', ...files])
  return { ok: res.code === 0, message: cliFirstLine(res) }
}

/** Restore the whole-file staged state after a failed selected-file commit. */
async function restoreStagedFiles(
  cwd: string,
  added: string[],
  removed: string[]
): Promise<{ ok: boolean; message: string }> {
  const unstaged = await unstageFiles(cwd, added)
  if (!unstaged.ok) return unstaged
  return removed.length ? stageFiles(cwd, removed) : unstaged
}

/** Keep only `files` that `requested` names, or all of them when nothing is requested. */
function filterSelected(files: string[], requested?: string[]): string[] {
  if (!requested) return files
  const selected = new Set(requested)
  return files.filter((file) => selected.has(file))
}

function selectedCommittableFiles(st: GitStatus, requested?: string[]): string[] {
  return filterSelected(committableFiles(st).files, requested)
}

function indexChanges(st: GitStatus, selected: string[]): { added: string[]; removed: string[] } {
  const staged = new Set(st.staged.map((file) => file.path))
  const selectedSet = new Set(selected)
  return {
    added: selected.filter((file) => !staged.has(file)),
    removed: st.staged.map((file) => file.path).filter((file) => !selectedSet.has(file))
  }
}

async function failedCommit(
  cwd: string,
  added: string[],
  removed: string[],
  failure: string,
  fallback: string,
  hookRun?: GitHookRun
): Promise<{ ok: false; error: string; hookRun?: GitHookRun }> {
  const restored = await restoreStagedFiles(cwd, added, removed)
  const message = failure || fallback
  return {
    ok: false,
    error: restored.ok ? message : `${message}; ${restored.message || 'Could not restore staged files'}`,
    ...(hookRun ? { hookRun } : {})
  }
}

export async function push(cwd: string): Promise<{ ok: boolean; message: string; hookRun?: GitHookRun }> {
  const st = await status(cwd)
  const blocked = pushBlockReason(st)
  if (blocked) return { ok: false, message: blocked }
  const args = !st.upstream && st.remote ? ['push', '-u', st.remote, 'HEAD'] : ['push']
  const res = await git(cwd, args, 120_000)
  const line = cliFirstLine(res)
  if (res.code === 0) return { ok: true, message: line || 'Pushed' }
  const hookRun = await hookRunFor(cwd, 'push', (res.err || res.out).trim())
  return { ok: false, message: line || 'Push failed', ...(hookRun ? { hookRun } : {}) }
}

/** Bring a clean tracking branch forward without creating a merge commit. */
export async function pull(cwd: string): Promise<{ ok: boolean; message: string }> {
  const st = await status(cwd)
  if (!st.upstream) return { ok: false, message: 'Set an upstream branch before pulling.' }
  if (!st.clean) return { ok: false, message: 'Commit or stash local changes before pulling.' }
  const res = await git(cwd, ['pull', '--ff-only'], 120_000)
  const line = cliFirstLine(res)
  return { ok: res.code === 0, message: line || (res.code === 0 ? 'Already up to date' : 'Pull failed') }
}

async function commit(
  cwd: string,
  message: string
): Promise<{ ok: boolean; message: string; hookRun?: GitHookRun }> {
  const trimmed = message.trim()
  if (!trimmed) return { ok: false, message: 'Commit message is empty' }
  const res = await git(cwd, ['commit', '-m', trimmed])
  const line = cliFirstLine(res)
  if (res.code === 0) return { ok: true, message: line || 'Committed' }
  const hookRun = await hookRunFor(cwd, 'commit', (res.err || res.out).trim())
  return { ok: false, message: line || 'Commit failed', ...(hookRun ? { hookRun } : {}) }
}

const COMMIT_MSG_LIMIT = 24_000

/** Drop a fenced code block wrapper (` ```lang … ``` `) if the reply is wrapped in one. */
function stripCodeFence(raw: string): string {
  const text = raw.trim()
  if (!text.startsWith('```')) return text
  return text.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim()
}

/** Strip markdown fences and cap AI commit output to a short message. */
export function sanitizeCommitMessage(raw: string): string {
  return stripCodeFence(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 12)
    .join('\n')
}

function commitMessagePrompt(diff: string, untracked: string[]): string {
  const extra = untracked.length
    ? `\nUntracked files that will be added:\n${untracked.map((f) => `- ${f}`).join('\n')}`
    : ''
  return [
    'Write a concise git commit message (1–2 sentences) for the changes below.',
    'Use conventional commit style when it fits. Output ONLY the commit message — no quotes, labels, or explanation.',
    '',
    '---',
    (diff + extra).slice(0, COMMIT_MSG_LIMIT)
  ].join('\n')
}

export type CommitDraft = {
  ok: boolean
  message?: string
  files?: string[]
  skipped?: string[]
  error?: string
}

async function commitDiff(cwd: string, tracked: string[], untracked: string[]): Promise<string> {
  const parts: string[] = []
  if (tracked.length) {
    const diffRes = await git(cwd, ['diff', 'HEAD', '--stat', '--patch', '--', ...tracked])
    if (diffRes.out.trim()) parts.push(diffRes.out.trim())
  }
  for (const file of untracked) {
    const extra = await git(cwd, ['diff', '--no-index', '--stat', '--patch', '--', '/dev/null', file])
    if (extra.out.trim()) parts.push(extra.out.trim())
  }
  return parts.join('\n')
}

/** Generate a message from the working tree. Does not touch the index. */
export async function draftCommit(
  cwd: string,
  provider: AiProvider,
  model?: string,
  selectedFiles?: string[]
): Promise<CommitDraft> {
  const st = await status(cwd)
  const blocked = commitBlockReason(st)
  if (blocked) return { ok: false, error: blocked }

  const { files: available, skipped } = committableFiles(st)
  const files = filterSelected(available, selectedFiles)
  if (!files.length) return { ok: false, error: 'Select at least one file to generate a commit message.' }
  const untracked = st.untracked.map((f) => f.path).filter((p) => files.includes(p))
  const tracked = files.filter((p) => !untracked.includes(p))
  const diff = await commitDiff(cwd, tracked, untracked)
  if (!diff && !untracked.length) {
    return { ok: false, error: 'Nothing to commit.' }
  }

  const ai = await runAiOnce(provider, commitMessagePrompt(diff, untracked), cwd, 120_000, model)
  if (!ai.ok) return { ok: false, error: ai.error || 'Could not generate commit message' }
  const message = sanitizeCommitMessage(ai.text)
  if (!message) return { ok: false, error: 'AI returned an empty commit message' }
  return { ok: true, message, files, skipped }
}

const PR_CONTEXT_LIMIT = 48_000
const PR_TITLE_LIMIT = 120
const PR_BODY_LIMIT = 8_000

/** Strip fences and labels from an AI PR title. */
export function sanitizePrTitle(raw: string): string {
  const title = stripCodeFence(raw)
    .replace(/^(?:title|pr title)\s*[:\-–]\s*/i, '')
    .trim()
  const line = title.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.slice(0, PR_TITLE_LIMIT)
}

/** Strip fences and a leading DESCRIPTION label from an AI PR body. */
export function sanitizePrDescription(raw: string): string {
  return stripCodeFence(raw)
    .replace(/^(?:description|body|pr (?:description|body))\s*[:\-–]\s*/i, '')
    .trim()
    .slice(0, PR_BODY_LIMIT)
}

/** Parse a structured AI reply into title + description. */
export function parsePrDraftResponse(raw: string): { title: string; description: string } {
  const text = stripCodeFence(raw)

  const titleMatch = text.match(/^title\s*[:\-–]\s*(.+)$/im)
  const descMatch = text.match(/^description\s*[:\-–]\s*\n?([\s\S]*)$/im)
  if (titleMatch || descMatch) {
    const afterTitle = titleMatch
      ? text.slice(titleMatch.index! + titleMatch[0].length).replace(/^\n+/, '')
      : text
    const description = descMatch
      ? descMatch[1] ?? ''
      : afterTitle.replace(/^description\s*[:\-–]\s*/im, '')
    return {
      title: sanitizePrTitle(titleMatch?.[1] ?? ''),
      description: sanitizePrDescription(description)
    }
  }

  const [first, ...rest] = text.split(/\n\n+/)
  return {
    title: sanitizePrTitle(first ?? ''),
    description: sanitizePrDescription(rest.join('\n\n'))
  }
}

function prDraftPrompt(base: string, log: string, diff: string): string {
  return [
    `Write a GitHub pull request title and description for merging the current branch into ${base}.`,
    'Output exactly this shape (no markdown fences, no extra labels):',
    'TITLE: <one-line title>',
    'DESCRIPTION:',
    '<markdown body with a short summary and, when useful, a test plan>',
    '',
    '--- Commits ---',
    log || '(no commits listed)',
    '',
    '--- Diff ---',
    (diff || '(empty diff)').slice(0, PR_CONTEXT_LIMIT)
  ].join('\n')
}

async function prCompareContext(
  cwd: string,
  base: string
): Promise<{ ok: true; log: string; diff: string } | { ok: false; error: string }> {
  const from = await resolveBase(cwd, base)
  if (!from) return { ok: false, error: `Unknown base branch ${base.trim()}.` }
  const range = `${from.ref}...HEAD`
  const [logRes, namesRes] = await Promise.all([
    git(cwd, ['log', '--oneline', range, '--', '.'], 30_000),
    git(cwd, ['diff', '--name-only', range], 30_000)
  ])
  const paths = namesRes.out
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p && !isSecretPath(p))
  const diffRes = paths.length
    ? await git(cwd, ['diff', '--stat', '--patch', range, '--', ...paths], 60_000)
    : { code: 0, out: '', err: '' }
  return {
    ok: true,
    log: logRes.out.trim(),
    diff: diffRes.out.trim()
  }
}

export type PrContentDraft = {
  ok: boolean
  title?: string
  description?: string
  error?: string
}

/** Generate a PR title and description from commits + diff vs the chosen base. */
export async function draftPullRequest(
  cwd: string,
  provider: AiProvider,
  model?: string,
  base?: string
): Promise<PrContentDraft> {
  const baseName = base?.trim()
  if (!baseName) return { ok: false, error: 'Choose a base branch before generating a pull request.' }

  const context = await prCompareContext(cwd, baseName)
  if (!context.ok) return context
  if (!context.log && !context.diff) {
    return { ok: false, error: `No commits or changes against ${baseName}.` }
  }

  const ai = await runAiOnce(
    provider,
    prDraftPrompt(baseName, context.log, context.diff),
    cwd,
    120_000,
    model
  )
  if (!ai.ok) return { ok: false, error: ai.error || 'Could not generate pull request content' }
  const parsed = parsePrDraftResponse(ai.text)
  if (!parsed.title) return { ok: false, error: 'AI returned an empty pull request title' }
  return { ok: true, title: parsed.title, description: parsed.description }
}

/** Make the index match `files`, commit, and restore its prior state on failure. */
export async function commitAll(
  cwd: string,
  message: string,
  files?: string[]
): Promise<{ ok: boolean; message?: string; error?: string; hookRun?: GitHookRun }> {
  const st = await status(cwd)
  const blocked = commitBlockReason(st)
  if (blocked) return { ok: false, error: blocked }

  const selected = selectedCommittableFiles(st, files)
  if (!selected.length) return { ok: false, error: 'Select at least one file to commit.' }
  const text = sanitizeCommitMessage(message)
  if (!text) return { ok: false, error: 'Commit message is empty' }

  const { added, removed } = indexChanges(st, selected)

  const unstaged = await unstageFiles(cwd, removed)
  if (!unstaged.ok) {
    return failedCommit(cwd, added, removed, unstaged.message, 'Could not update staged files')
  }

  const staged = await stageFiles(cwd, selected)
  if (!staged.ok) {
    return failedCommit(cwd, added, removed, staged.message, 'Could not stage changes')
  }
  const done = await commit(cwd, text)
  if (!done.ok) {
    return failedCommit(cwd, added, removed, done.message, 'Commit failed', done.hookRun)
  }
  return { ok: true, message: text }
}

/** Resolve the checkout that stores `.farol/pipelines.json` for this repo. */
export async function pipelineStoreRootFor(cwd: string): Promise<string> {
  const abs = path.resolve(cwd)
  const [inside, trees, common] = await Promise.all([
    git(abs, ['rev-parse', '--is-inside-work-tree']),
    git(abs, ['worktree', 'list', '--porcelain']),
    git(abs, ['rev-parse', '--git-common-dir'])
  ])
  if (inside.code !== 0 || inside.out.trim() !== 'true') return abs
  return pipelineStoreRoot(abs, parseWorktreeList(trees.out), common.out.trim() || null)
}

/**
 * Watch HEAD so the UI follows branch changes made anywhere else — in a shell
 * pane, in another terminal, or by a pipeline step.
 */
export class HeadWatcher {
  private watchers = new Map<string, fs.FSWatcher>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(private onChange: (cwd: string) => void) {}

  async watch(cwd: string): Promise<void> {
    if (this.watchers.has(cwd)) return
    const dir = await git(cwd, ['rev-parse', '--absolute-git-dir'])
    const gitDir = dir.out.trim()
    if (dir.code !== 0 || !gitDir) return

    const head = path.join(gitDir, 'HEAD')
    try {
      const watcher = fs.watch(head, () => {
        // Checkouts touch HEAD more than once; collapse the burst.
        const timer = this.timers.get(cwd)
        if (timer) clearTimeout(timer)
        this.timers.set(
          cwd,
          setTimeout(() => {
            this.timers.delete(cwd)
            this.onChange(cwd)
          }, 120)
        )
      })
      this.watchers.set(cwd, watcher)
    } catch {
      /* not watchable (network FS, permissions) — the UI still refreshes on demand */
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }
}
