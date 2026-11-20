import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { createPullRequest } = vi.hoisted(() => ({ createPullRequest: vi.fn() }))
vi.mock('./ai-oneshot', () => ({ runAiOnce: vi.fn() }))
vi.mock('./github', () => ({
  createPullRequest,
  githubInfo: vi.fn().mockResolvedValue({ available: true, prs: [] }),
  githubGitEnv: vi.fn().mockResolvedValue(undefined)
}))

import { performGitAction } from './git-actions'

const dirs: string[] = []
const FILES = ['a.txt', 'b.txt', 'app.txt', 'sub/app.txt']

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-git-actions-'))
  dirs.push(dir)
  return dir
}

function configure(dir: string): void {
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
}

/** A clean repository on `main` with every file in FILES committed. */
function cleanRepo(): string {
  const dir = tmpDir()
  git(dir, 'init', '-q')
  configure(dir)
  fs.mkdirSync(path.join(dir, 'sub'))
  for (const file of FILES) fs.writeFileSync(path.join(dir, file), 'one\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
  git(dir, 'branch', '-M', 'main')
  return dir
}

/** Every file in FILES edited, and a new `c.txt` beside them. */
function dirtyRepo(): string {
  const dir = cleanRepo()
  for (const file of FILES) fs.writeFileSync(path.join(dir, file), 'two\n')
  fs.writeFileSync(path.join(dir, 'c.txt'), 'new\n')
  return dir
}

const committed = (dir: string): string => git(dir, 'show', '--name-only', '--format=', 'HEAD').trim()

afterEach(() => {
  createPullRequest.mockReset()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('performGitAction', () => {
  it('reports the branch and the changed files', async () => {
    const repo = dirtyRepo()
    const res = await performGitAction(repo, { action: 'status' }, repo)
    expect(res.ok).toBe(true)
    expect(res.message).toContain('Branch main: no remote.')
    expect(res.message).toContain('modified: a.txt')
    expect(res.message).toContain('untracked: c.txt')
  })

  it('commits only the files it is given and leaves the rest of the working tree alone', async () => {
    const repo = dirtyRepo()
    const res = await performGitAction(repo, { action: 'commit', message: 'feat: change a', files: ['a.txt'] }, repo)
    expect(res).toEqual({ ok: true, message: 'Committed 1 file: feat: change a' })
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('feat: change a')
    expect(committed(repo)).toBe('a.txt')
    expect(git(repo, 'status', '--porcelain').split('\n').filter(Boolean)).toEqual([
      ' M app.txt',
      ' M b.txt',
      ' M sub/app.txt',
      '?? c.txt'
    ])
  })

  it('names files from the top of the repository, so an agent working in a subfolder commits the right ones', async () => {
    const repo = dirtyRepo()
    const res = await performGitAction(path.join(repo, 'sub'), { action: 'commit', message: 'fix: top app', files: ['app.txt'] }, repo)
    expect(res.ok).toBe(true)
    // `sub/app.txt` changed too, and is what `git add app.txt` would have staged from `sub`.
    expect(committed(repo)).toBe('app.txt')
    expect(git(repo, 'status', '--porcelain')).toContain(' M sub/app.txt')
  })

  it('has nothing to commit when no files are named', async () => {
    const repo = dirtyRepo()
    await expect(performGitAction(repo, { action: 'commit', message: 'm', files: [] }, repo)).resolves.toEqual({
      ok: false,
      message: 'There are no files to commit: this turn changed none.'
    })
  })

  it('returns the output of the hook that blocks the commit and leaves nothing staged', async () => {
    const repo = dirtyRepo()
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit')
    fs.writeFileSync(hook, '#!/bin/sh\necho "lint: 2 errors" >&2\nexit 1\n')
    fs.chmodSync(hook, 0o755)

    const res = await performGitAction(repo, { action: 'commit', message: 'm', files: ['a.txt'] }, repo)

    expect(res.ok).toBe(false)
    expect(res.hookRun?.hooks).toEqual(['pre-commit'])
    expect(res.hookRun?.output).toContain('lint: 2 errors')
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('')
  })

  it('pushes the branch, publishing it when it has no upstream yet, from a subfolder too', async () => {
    const origin = cleanRepo()
    const clone = tmpDir()
    execFileSync('git', ['clone', '-q', origin, clone])
    configure(clone)
    git(clone, 'checkout', '-q', '-b', 'feat')
    fs.writeFileSync(path.join(clone, 'f.txt'), 'x\n')
    git(clone, 'add', 'f.txt')
    git(clone, 'commit', '-qm', 'feat')

    const res = await performGitAction(path.join(clone, 'sub'), { action: 'push' }, clone)

    expect(res.ok).toBe(true)
    expect(git(origin, 'branch', '--list', 'feat').trim()).toBe('feat')
  })

  it('opens a pull request from the top of the repository', async () => {
    const repo = dirtyRepo()
    createPullRequest.mockResolvedValue({
      ok: true,
      message: 'Pull request created: https://github.com/acme/repo/pull/7',
      github: { available: true, prs: [] }
    })
    const res = await performGitAction(path.join(repo, 'sub'), { action: 'create_pr', base: 'main', title: 'T', body: 'B' }, repo)
    expect(res).toEqual({ ok: true, message: 'Pull request created: https://github.com/acme/repo/pull/7' })
    expect(createPullRequest).toHaveBeenCalledWith(fs.realpathSync(repo), 'main', 'T', 'B')
  })

  it('does not commit, push or open a pull request once the checkout has left the branch the turn began on', async () => {
    const repo = dirtyRepo()
    const moved = { ok: false, message: 'The checkout moved from feat to main, so Farol did not go on.' }
    const scope = { branch: 'feat', tree: undefined }

    await expect(performGitAction(repo, { action: 'commit', message: 'm', files: ['a.txt'] }, repo, scope)).resolves.toEqual(moved)
    await expect(performGitAction(repo, { action: 'push' }, repo, scope)).resolves.toEqual(moved)
    await expect(performGitAction(repo, { action: 'create_pr' }, repo, scope)).resolves.toEqual(moved)
    expect(createPullRequest).not.toHaveBeenCalled()
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('init')
  })

  it('does not open a pull request whose turn was stopped while it waited behind another', async () => {
    const repo = dirtyRepo()
    let release!: () => void
    createPullRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve({ ok: true, message: 'Pull request created' })
      })
    )
    const first = performGitAction(repo, { action: 'create_pr' }, repo)
    await vi.waitFor(() => expect(createPullRequest).toHaveBeenCalledTimes(1))
    const stop = new AbortController()
    const second = performGitAction(repo, { action: 'create_pr' }, repo, { branch: 'main', tree: undefined, signal: stop.signal })
    await new Promise((resolve) => setTimeout(resolve, 150))
    stop.abort()

    // The pull request that was already being opened finishes; the one that was still waiting never starts.
    release()
    await expect(first).resolves.toEqual({ ok: true, message: 'Pull request created' })
    await expect(second).resolves.toEqual({ ok: false, message: 'Stopped before it began.' })
    expect(createPullRequest).toHaveBeenCalledTimes(1)
  })

  it('refuses a folder that is not in a repository', async () => {
    const dir = tmpDir()
    await expect(performGitAction(dir, { action: 'status' }, dir)).resolves.toEqual({
      ok: false,
      message: 'This folder is not in a Git repository.'
    })
  })
})

describe('performGitAction with a checkout', () => {
  /** Where the confining caller would have put it: with its symlinks resolved. */
  const real = (dir: string): string => fs.realpathSync(dir)

  it('acts on the checkout\'s own repository, from a subfolder too', async () => {
    const repo = real(dirtyRepo())
    await expect(performGitAction(path.join(repo, 'sub'), { action: 'status' }, repo)).resolves.toMatchObject({ ok: true })
  })

  it('refuses a repository that is not the checkout\'s, and touches nothing in it', async () => {
    const mine = real(dirtyRepo())
    const theirs = real(dirtyRepo())

    const res = await performGitAction(theirs, { action: 'commit', message: 'm', files: ['a.txt'] }, mine)

    expect(res).toEqual({ ok: false, message: 'This folder is in a repository that is not part of the open project.' })
    expect(git(theirs, 'log', '-1', '--format=%s').trim()).toBe('init')
    expect(git(theirs, 'status', '--porcelain')).toContain(' M a.txt')
  })

  it('refuses a folder reached through a link inside the checkout that leads to another repository', async () => {
    const mine = real(dirtyRepo())
    const theirs = real(dirtyRepo())
    fs.symlinkSync(theirs, path.join(mine, 'link'))

    const res = await performGitAction(path.join(mine, 'link'), { action: 'commit', message: 'm', files: ['a.txt'] }, mine)

    expect(res).toEqual({ ok: false, message: 'This folder is in a repository that is not part of the open project.' })
    expect(git(theirs, 'log', '-1', '--format=%s').trim()).toBe('init')
    expect(git(theirs, 'diff', '--cached', '--name-only').trim()).toBe('')
  })

  it('acts on a repository nested inside the checkout', async () => {
    const repo = real(dirtyRepo())
    const nested = path.join(repo, 'vendor')
    fs.mkdirSync(nested)
    git(nested, 'init', '-q')
    configure(nested)
    git(nested, 'commit', '--allow-empty', '-qm', 'init')
    await expect(performGitAction(nested, { action: 'status' }, repo)).resolves.toMatchObject({ ok: true })
  })

  it('acts on the repository that holds a checkout which is only a subfolder of it', async () => {
    const sub = path.join(real(dirtyRepo()), 'sub')
    await expect(performGitAction(sub, { action: 'status' }, sub)).resolves.toMatchObject({ ok: true })
  })

  it('refuses when the checkout is unknown: empty, or not a folder that exists', async () => {
    const repo = real(dirtyRepo())
    for (const checkout of ['', path.join(repo, 'missing')]) {
      await expect(performGitAction(repo, { action: 'status' }, checkout)).resolves.toEqual({
        ok: false,
        message: 'This folder is in a repository that is not part of the open project.'
      })
    }
  })
})
