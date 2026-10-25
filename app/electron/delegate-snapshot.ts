/**
 * Snapshots of a checkout taken around a subagent run, so its changes can be
 * shown on their own and undone without touching the developer's branch,
 * index or stash list. Chat also snapshots around each agent turn, to see
 * whether it changed files however it wrote them, and pipeline git steps diff
 * against one.
 *
 * A snapshot is a git tree of the working copy — tracked and untracked files,
 * `.gitignore` respected — written through a throwaway index file. Starting
 * that index from a copy of the real one means `git add -A` only rehashes
 * files that changed.
 */

import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

export function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env },
      (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout))
    )
  })
}

export interface Capture {
  tree: string
  /** Changed or untracked files over the size limit, left out of `tree`. */
  skipped: string[]
}

/** Modified and untracked files larger than `maxBytes`, as paths relative to `root`. */
async function oversized(root: string, maxBytes: number): Promise<string[]> {
  const listed = await git(root, ['ls-files', '-z', '--modified', '--others', '--exclude-standard'])
  const big: string[] = []
  for (const file of new Set(listed.split('\0').filter(Boolean))) {
    try {
      if (fs.statSync(path.join(root, file)).size > maxBytes) big.push(file)
    } catch {
      /* deleted since listing */
    }
  }
  return big
}

/**
 * The working copy as a tree, with an optional size limit on what is added.
 * Undefined outside a git checkout. Starting the throwaway index from a copy
 * of the real one means `git add -A` only rehashes files that changed.
 */
export async function captureLimited(cwd: string, maxBytes?: number): Promise<Capture | undefined> {
  let root: string
  let realIndex: string
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
    realIndex = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim())
  } catch {
    return undefined
  }
  const skipped = maxBytes === undefined ? [] : await oversized(root, maxBytes)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-snap-'))
  const index = path.join(dir, 'index')
  try {
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, index)
    const env = { GIT_INDEX_FILE: index }
    if (skipped.length) {
      const specs = path.join(dir, 'pathspecs')
      fs.writeFileSync(specs, ['.', ...skipped.map((file) => `:(exclude,literal)${file}`)].join('\0'))
      await git(root, ['add', '-A', '--pathspec-from-file', specs, '--pathspec-file-nul'], env)
    } else await git(root, ['add', '-A', '--', '.'], env)
    return { tree: (await git(root, ['write-tree'], env)).trim(), skipped }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** The working copy of `cwd`'s checkout as a tree id, or undefined outside a git checkout. */
export async function captureTree(cwd: string): Promise<string | undefined> {
  return (await captureLimited(cwd))?.tree
}

/** Where `HEAD`'s branch left `base`: the commit a branch diff starts from. Rejects when `base` is unknown. */
export async function mergeBase(cwd: string, base: string): Promise<string> {
  return (await git(cwd, ['merge-base', base, 'HEAD'])).trim()
}

/** The paths that differ between two snapshots, relative to the checkout root. */
export async function changedPaths(cwd: string, before: string, after: string): Promise<string[]> {
  if (before === after) return []
  return (await git(cwd, ['diff', '--name-only', '--no-renames', '-z', before, after])).split('\0').filter(Boolean)
}

/** `git diff --stat` between two snapshots; empty when nothing changed. */
export async function treeDiffStat(cwd: string, before: string, after: string): Promise<string> {
  if (before === after) return ''
  return (await git(cwd, ['diff', '--stat', '--no-color', before, after])).trimEnd()
}

const REF_ROOT = 'refs/farol/delegate'

/** Ref names allow only a narrow alphabet; task and run ids may hold anything. */
function refPart(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '') || '-'
}

/** Keep a snapshot from `git gc` until its chat is cleared. */
export async function pinTree(cwd: string, taskId: string, runId: string, name: 'before' | 'after', tree: string): Promise<void> {
  await git(cwd, ['update-ref', `${REF_ROOT}/${refPart(taskId)}/${refPart(runId)}/${name}`, tree])
}

/** Drop every snapshot a chat pinned. */
export async function releaseTrees(cwd: string, taskId: string): Promise<void> {
  const refs = (await git(cwd, ['for-each-ref', '--format=%(refname)', `${REF_ROOT}/${refPart(taskId)}/`]))
    .split('\n')
    .filter(Boolean)
  for (const ref of refs) await git(cwd, ['update-ref', '-d', ref])
}

/** Apply the change from `from` to `to` onto the working copy only; never the index. */
export async function applyChange(cwd: string, from: string, to: string, check: boolean): Promise<void> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  const patch = await git(root, ['diff', '--binary', '--no-color', '--no-ext-diff', from, to])
  if (!patch) return
  await new Promise<void>((resolve, reject) => {
    const proc = execFile('git', ['apply', ...(check ? ['--check'] : []), '-'], { cwd: root }, (error, _out, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve()
    )
    proc.stdin?.end(patch)
  })
}

export type UndoOutcome =
  | { ok: true }
  /** Later edits overlap; nothing was changed. `restoreFiles` is what restoring `before` would touch. */
  | { ok: false; conflict: string; restoreFiles: number }

/**
 * Reverse exactly what happened between `before` and `after`, keeping later
 * edits that do not overlap. All or nothing: a reverse patch that does not
 * apply cleanly changes no file.
 */
export async function undoChange(cwd: string, before: string, after: string): Promise<UndoOutcome> {
  try {
    await applyChange(cwd, after, before, true)
  } catch (error) {
    const now = await captureTree(cwd)
    const files = now ? (await git(cwd, ['diff', '--name-only', now, before])).split('\n').filter(Boolean).length : 0
    return { ok: false, conflict: error instanceof Error ? error.message : String(error), restoreFiles: files }
  }
  await applyChange(cwd, after, before, false)
  return { ok: true }
}

/** Put the whole working copy back to `before`, discarding everything since. */
export async function restoreTree(cwd: string, before: string): Promise<void> {
  const now = await captureTree(cwd)
  if (now) await applyChange(cwd, now, before, false)
}

/**
 * Drop the snapshots of every chat not in `keep` (task ids). Run when a
 * project's saved session loads, it catches what clearing a chat cannot: a
 * chat cleared after a restart, when the app no longer knew its runs, or one
 * whose worktree was removed. Refs live in the repository's shared git dir, so
 * any checkout of it sees them all.
 */
export async function pruneTrees(cwd: string, keep: Iterable<string>): Promise<number> {
  const kept = new Set([...keep].map(refPart))
  const refs = (await git(cwd, ['for-each-ref', '--format=%(refname)', `${REF_ROOT}/`])).split('\n').filter(Boolean)
  let dropped = 0
  for (const ref of refs) {
    const task = ref.slice(REF_ROOT.length + 1).split('/')[0]
    if (kept.has(task)) continue
    await git(cwd, ['update-ref', '-d', ref])
    dropped += 1
  }
  return dropped
}
