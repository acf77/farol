/**
 * Per-turn checkpoints of a chat's working copy: what the files looked like
 * when each user message started and when its turn ended, so one turn's
 * changes can be listed and the files put back to before any turn.
 *
 * A checkpoint is one ref, `refs/farol/checkpoints/<chat>/<NNNNNN>`, pointing
 * at a small tree: `before/` and `after/` (snapshots from `captureLimited`)
 * and `meta.json`. A tree is not a commit, so nothing walks it — `git log
 * --all`, `git branch` and `git push` never see it — and each turn keeps only
 * its own objects alive, so pruning a turn lets `git gc` reclaim them. The
 * index, HEAD, branch, stash and reflog are never touched.
 */

import { execFile } from 'child_process'
import type { RevertOutcome, TurnFile, TurnInfo } from '../shared/types'
import { applyChange, captureLimited, git, type Capture } from './delegate-snapshot'

export const CHECKPOINT_ROOT = 'refs/farol/checkpoints'
export const DEFAULT_CHECKPOINT_LIMIT = 100
/** Changed or untracked files over this size stay out of a checkpoint. */
export const CHECKPOINT_MAX_FILE_BYTES = 10 * 1024 * 1024
/** Files listed per turn in `meta.json`; `fileCount` keeps the true number. */
const MAX_LISTED_FILES = 500
const PREVIEW_CHARS = 120

/** Ref names allow only a narrow alphabet; chat ids may hold anything. */
function refPart(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '') || '-'
}

const chatRoot = (taskId: string): string => `${CHECKPOINT_ROOT}/${refPart(taskId)}`
const turnRef = (taskId: string, turn: number): string => `${chatRoot(taskId)}/${String(turn).padStart(6, '0')}`

function gitWithInput(cwd: string, args: string[], input: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      'git',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => (error ? reject(new Error(stderr.toString().trim() || error.message)) : resolve(stdout))
    )
    proc.stdin?.end(input)
  })
}

/** The words of a user message worth showing in the turn list. */
export function turnPreview(text: string): string {
  const own = text
    .split(/\n{2,}/)
    .filter((part) => !part.startsWith('Note from Farol:'))
    .join(' ')
    .replace(/^User request:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return own.length > PREVIEW_CHARS ? `${own.slice(0, PREVIEW_CHARS - 1)}…` : own
}

/** Per-file line counts between two trees. */
export async function diffFiles(cwd: string, from: string, to: string): Promise<TurnFile[]> {
  if (from === to) return []
  const out = await git(cwd, ['diff', '--numstat', '--no-renames', '-z', from, to])
  const files: TurnFile[] = []
  for (const entry of out.split('\0').filter(Boolean)) {
    const [added, removed, ...rest] = entry.split('\t')
    files.push({
      path: rest.join('\t'),
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed)
    })
  }
  return files
}

async function writeCheckpoint(cwd: string, taskId: string, meta: TurnInfo, before: string, after?: string): Promise<void> {
  const blob = (await gitWithInput(cwd, ['hash-object', '-w', '--stdin'], JSON.stringify(meta))).toString().trim()
  const entries = [`100644 blob ${blob}\tmeta.json`, `040000 tree ${before}\tbefore`]
  if (after && after !== before) entries.push(`040000 tree ${after}\tafter`)
  const tree = (await gitWithInput(cwd, ['mktree'], `${entries.join('\n')}\n`)).toString().trim()
  await git(cwd, ['update-ref', turnRef(taskId, meta.turn), tree])
}

async function turnNumbers(cwd: string, taskId: string): Promise<number[]> {
  const refs = await git(cwd, ['for-each-ref', '--format=%(refname)', `${chatRoot(taskId)}/`])
  return refs
    .split('\n')
    .filter(Boolean)
    .map((ref) => Number(ref.slice(ref.lastIndexOf('/') + 1)))
    .filter(Number.isInteger)
    .sort((a, b) => a - b)
}

/** The chat's checkpoints, oldest first. Unreadable ones are left out. */
export async function listTurns(cwd: string, taskId: string): Promise<TurnInfo[]> {
  const numbers = await turnNumbers(cwd, taskId).catch(() => [])
  if (!numbers.length) return []
  const input = numbers.map((n) => `${turnRef(taskId, n)}:meta.json\n`).join('')
  const out = await gitWithInput(cwd, ['cat-file', '--batch'], input)
  const turns: TurnInfo[] = []
  let at = 0
  while (at < out.length) {
    const eol = out.indexOf(0x0a, at)
    if (eol < 0) break
    const header = out.subarray(at, eol).toString().split(' ')
    if (header[1] !== 'blob') {
      at = eol + 1
      continue
    }
    const size = Number(header[2])
    const body = out.subarray(eol + 1, eol + 1 + size).toString()
    at = eol + 1 + size + 1
    try {
      turns.push(JSON.parse(body) as TurnInfo)
    } catch {
      /* a damaged checkpoint is skipped */
    }
  }
  return turns
}

/** The working copy at the start of a turn and, when it ended with changes, at its end. */
async function turnTrees(cwd: string, taskId: string, turn: number): Promise<{ before: string; after?: string } | undefined> {
  const ref = turnRef(taskId, turn)
  const resolve = (path: string): Promise<string | undefined> =>
    git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}:${path}`]).then((out) => out.trim(), () => undefined)
  const before = await resolve('before')
  if (!before) return undefined
  return { before, after: await resolve('after') }
}

/** One write at a time per chat, so turn numbers and refs never race. Failures are best effort. */
const chains = new Map<string, Promise<unknown>>()
function serial<T>(taskId: string, work: () => Promise<T>): Promise<T | undefined> {
  const next = (chains.get(taskId) ?? Promise.resolve()).then(work).catch(() => undefined)
  chains.set(taskId, next)
  void next.then(() => {
    if (chains.get(taskId) === next) chains.delete(taskId)
  })
  return next
}

export interface TurnRecord {
  /** The turn's number once its checkpoint is written; undefined if git refused. */
  started: Promise<number | undefined>
  /** Write the end of the turn and prune old checkpoints. Never throws. */
  finish(after: Capture | undefined, limit?: number): Promise<void>
}

/**
 * Begin a checkpoint from a snapshot taken before the turn's first change.
 * The writes run behind the caller, in order; it need not await them.
 */
export function startTurn(
  cwd: string,
  taskId: string,
  before: Capture,
  prompt: string,
  kind: TurnInfo['kind'] = 'turn'
): TurnRecord {
  const at = Date.now()
  const meta = (turn: number): TurnInfo => ({
    turn,
    at,
    prompt,
    kind,
    done: false,
    changed: false,
    files: [],
    fileCount: 0,
    skipped: before.skipped
  })
  const started = serial(taskId, async () => {
    const turn = ((await turnNumbers(cwd, taskId)).pop() ?? 0) + 1
    await writeCheckpoint(cwd, taskId, meta(turn), before.tree)
    return turn
  })
  const finish = async (after: Capture | undefined, limit = DEFAULT_CHECKPOINT_LIMIT): Promise<void> => {
    await serial(taskId, async () => {
      const turn = await started
      if (turn === undefined) return
      const end = after ?? { tree: before.tree, skipped: [] }
      const files = await diffFiles(cwd, before.tree, end.tree)
      const done: TurnInfo = {
        ...meta(turn),
        done: true,
        changed: files.length > 0,
        files: files.slice(0, MAX_LISTED_FILES),
        fileCount: files.length,
        skipped: [...new Set([...before.skipped, ...end.skipped])]
      }
      await writeCheckpoint(cwd, taskId, done, before.tree, end.tree)
      if (done.skipped.length) console.warn(`[checkpoints] ${taskId} turn ${turn} skipped files over the size limit:`, done.skipped)
      await trim(cwd, taskId, limit)
    })
  }
  return { started, finish }
}

/** Keep the newest `limit` checkpoints of a chat. Objects of the rest wait for `git gc`. */
async function trim(cwd: string, taskId: string, limit: number): Promise<void> {
  const numbers = await turnNumbers(cwd, taskId)
  for (const turn of numbers.slice(0, Math.max(0, numbers.length - Math.max(1, limit)))) {
    await git(cwd, ['update-ref', '-d', turnRef(taskId, turn)])
  }
}

/** Drop every checkpoint of a chat, after the writes already queued for it. */
export function releaseCheckpoints(cwd: string, taskId: string): Promise<void> {
  return serial(taskId, async () => {
    for (const turn of await turnNumbers(cwd, taskId)) await git(cwd, ['update-ref', '-d', turnRef(taskId, turn)])
  }).then(() => undefined)
}

/** Drop the checkpoints of every chat not in `keep`. Refs live in the shared git dir, so any checkout sees them all. */
export async function pruneCheckpoints(cwd: string, keep: Iterable<string>): Promise<number> {
  const kept = new Set([...keep].map(refPart))
  const refs = (await git(cwd, ['for-each-ref', '--format=%(refname)', `${CHECKPOINT_ROOT}/`])).split('\n').filter(Boolean)
  let dropped = 0
  for (const ref of refs) {
    if (kept.has(ref.slice(CHECKPOINT_ROOT.length + 1).split('/')[0])) continue
    await git(cwd, ['update-ref', '-d', ref])
    dropped += 1
  }
  return dropped
}

/** What reverting to before `turn` would change right now. */
export async function previewRevert(
  cwd: string,
  taskId: string,
  turn: number
): Promise<{ files: TurnFile[]; fileCount: number } | { message: string }> {
  const trees = await turnTrees(cwd, taskId, turn)
  if (!trees) return { message: 'This turn is no longer saved.' }
  const now = await captureLimited(cwd, CHECKPOINT_MAX_FILE_BYTES)
  if (!now) return { message: 'This folder is not a git checkout.' }
  const files = await diffFiles(cwd, now.tree, trees.before)
  return { files: files.slice(0, MAX_LISTED_FILES), fileCount: files.length }
}

/**
 * Put the working copy back to how it was before `turn`: files created since
 * go, edits since are undone, and the branch, HEAD and index stay as they are.
 * The state being replaced is saved first as its own checkpoint, so a revert
 * can be reverted. Files over the size limit are in neither snapshot and are
 * left alone.
 */
export async function revertToTurn(cwd: string, taskId: string, turn: number, limit?: number): Promise<RevertOutcome> {
  const trees = await turnTrees(cwd, taskId, turn)
  if (!trees) return { ok: false, message: 'This turn is no longer saved.' }
  const now = await captureLimited(cwd, CHECKPOINT_MAX_FILE_BYTES)
  if (!now) return { ok: false, message: 'This folder is not a git checkout.' }
  const safety = startTurn(cwd, taskId, now, `Revert to before turn ${turn}`, 'revert')
  if ((await safety.started) === undefined) return { ok: false, message: 'Could not save a safety checkpoint, so nothing was changed.' }
  const fileCount = (await diffFiles(cwd, now.tree, trees.before)).length
  try {
    await applyChange(cwd, now.tree, trees.before, false)
    return { ok: true, fileCount }
  } catch (error) {
    return { ok: false, message: `The files could not be restored: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    await safety.finish(await captureLimited(cwd, CHECKPOINT_MAX_FILE_BYTES).catch(() => undefined), limit)
  }
}
