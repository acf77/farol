import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { GitInfo } from '../shared/types'
import type { WorktreeRequest } from '../shared/worktree'
import { parseAlreadyOpenPath, parseWorktreeList, pipelineStoreRoot, worktreeFolderName } from '../shared/worktree'

/**
 * Real git, read through the CLI. Plain `execFile` rather than a PTY: this is
 * data for the UI, not something the user watches scroll by.
 */

function git(
  cwd: string,
  args: string[],
  timeout = 10_000
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((error as unknown as { code: number }).code as number)
            : error
              ? 1
              : 0
        resolve({ code, out: stdout.toString(), err: stderr.toString() })
      }
    )
  })
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

  const worktrees = parseWorktreeList(trees.out).flatMap((t) =>
    t.branch ? [{ path: t.path, branch: t.branch }] : []
  )

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
  const message = (res.err || res.out).trim().split('\n')[0] || ''
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
 * Open `branch` in a separate working copy so the project's current checkout
 * is left alone. Reuses an existing worktree for that branch when there is
 * one; otherwise creates a sibling folder (`repo-branch-name`, or `folder`).
 *
 * `base` only applies when the branch is being created — an existing branch is
 * checked out as it stands rather than being silently reset onto something else.
 */
export async function addWorktree(
  cwd: string,
  req: WorktreeRequest
): Promise<{ ok: boolean; path?: string; branch?: string; reused?: boolean; message: string }> {
  const name = req.branch.trim()
  if (!name) return { ok: false, message: 'Enter a branch name' }

  const [top, bareRes] = await Promise.all([
    git(cwd, ['rev-parse', '--show-toplevel']),
    git(cwd, ['rev-parse', '--is-bare-repository'])
  ])
  const bare = bareRes.code === 0 && bareRes.out.trim() === 'true'
  // Bare hubs have no work-tree toplevel; sibling worktrees still live next to `cwd`.
  const toplevel = top.code === 0 ? top.out.trim() : bare ? path.resolve(cwd) : ''
  if (!toplevel) {
    return { ok: false, message: (top.err || top.out).trim() || 'not a git repository' }
  }

  const listed = await git(cwd, ['worktree', 'list', '--porcelain'])
  const trees = parseWorktreeList(listed.out)
  const existing = trees.find((t) => t.branch === name)
  if (existing && fs.existsSync(existing.path)) {
    return { ok: true, path: existing.path, branch: name, reused: true, message: '' }
  }

  const head = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  // Never hand the bare hub back as a checkout — it cannot be used as a project cwd.
  if (!bare && head.out.trim() === name) {
    return { ok: true, path: toplevel, branch: name, reused: true, message: '' }
  }

  const destBase = path.join(
    path.dirname(toplevel),
    worktreeFolderName(path.basename(toplevel), name, req.folder)
  )
  if (fs.existsSync(destBase)) {
    const at = await git(destBase, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (at.code === 0 && at.out.trim() === name) {
      return { ok: true, path: destBase, branch: name, reused: true, message: '' }
    }
    // A folder the user named explicitly is not something to silently sidestep.
    if (req.folder?.trim()) {
      return { ok: false, message: `${path.basename(destBase)} already exists` }
    }
  }

  let dest = destBase
  for (let n = 2; fs.existsSync(dest); n++) dest = `${destBase}-${n}`

  let args: string[]
  if (await refExists(cwd, `refs/heads/${name}`)) {
    args = ['worktree', 'add', dest, name]
  } else if (req.base?.trim()) {
    const from = await resolveBase(cwd, req.base)
    if (!from) return { ok: false, message: `unknown branch ${req.base.trim()}` }
    args = from.remote
      ? ['worktree', 'add', '--track', '-b', name, dest, from.ref]
      : ['worktree', 'add', '-b', name, dest, from.ref]
  } else if (await refExists(cwd, `refs/remotes/origin/${name}`)) {
    args = ['worktree', 'add', '--track', '-b', name, dest, `origin/${name}`]
  } else {
    args = ['worktree', 'add', '-b', name, dest]
  }

  const res = await git(cwd, args, 120_000)
  if (res.code !== 0) {
    const message = (res.err || res.out).trim().split('\n').filter(Boolean).pop() || 'could not create worktree'
    const open = parseAlreadyOpenPath(message)
    if (open && fs.existsSync(open)) {
      return { ok: true, path: open, branch: name, reused: true, message: '' }
    }
    return { ok: false, message }
  }
  return { ok: true, path: dest, branch: name, message: '' }
}

/** Resolve the checkout that stores `.buildflow/pipelines.json` for this repo. */
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
