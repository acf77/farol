/**
 * Snapshots of a checkout taken around a subagent run, so its changes can be
 * shown on their own and undone without touching the developer's branch,
 * index or stash list.
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

function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env },
      (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout))
    )
  })
}

/** The working copy of `cwd`'s checkout as a tree id, or undefined outside a git checkout. */
export async function captureTree(cwd: string): Promise<string | undefined> {
  let root: string
  let realIndex: string
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
    realIndex = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim())
  } catch {
    return undefined
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-snap-'))
  const index = path.join(dir, 'index')
  try {
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, index)
    const env = { GIT_INDEX_FILE: index }
    await git(root, ['add', '-A', '--', '.'], env)
    return (await git(root, ['write-tree'], env)).trim()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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
async function applyChange(cwd: string, from: string, to: string, check: boolean): Promise<void> {
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
