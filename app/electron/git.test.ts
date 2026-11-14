import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runAiOnce, githubInfo, githubGitEnv, execCli, realExec } = vi.hoisted(() => ({
  runAiOnce: vi.fn(),
  githubInfo: vi.fn(),
  githubGitEnv: vi.fn(),
  /** Runs the real git, but lets a test see how it was called and make a command fail. */
  execCli: vi.fn(),
  realExec: { run: undefined as unknown as typeof import('./exec-cli').execCli }
}))
vi.mock('./ai-oneshot', () => ({ runAiOnce }))
vi.mock('./github', () => ({ githubInfo, githubGitEnv }))
vi.mock('./exec-cli', async (importOriginal) => {
  realExec.run = (await importOriginal<typeof import('./exec-cli')>()).execCli
  return { execCli }
})

import { bringPrConflicts, checkout, commitAll, draftCommit, draftPullRequest, githubStatus, hooksInfo, mergeBaseConflicts, mergeForConflicts, parseCommitLog, parsePrDraftResponse, pull, push, sanitizeCommitMessage, sanitizePrDescription, sanitizePrTitle, status, syncManagedHooks } from './git'
import type { Pipeline } from '../shared/types'
import { captureTree } from './delegate-snapshot'

const dirs: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-git-'))
  dirs.push(dir)
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  return dir
}

beforeEach(() => {
  githubInfo.mockResolvedValue({ available: true, prs: [] })
  githubGitEnv.mockResolvedValue(undefined)
  execCli.mockImplementation((...args: Parameters<typeof realExec.run>) => realExec.run(...args))
})

afterEach(() => {
  runAiOnce.mockReset()
  githubInfo.mockReset()
  githubGitEnv.mockReset()
  execCli.mockReset()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** Two branches that both edit `file.txt` so a merge with `staging` conflicts. */
function conflictRepo(): string {
  const cwd = tmpRepo()
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'base\n')
  git(cwd, ['add', 'file.txt'])
  git(cwd, ['commit', '-m', 'init'])
  git(cwd, ['branch', '-M', 'main'])
  git(cwd, ['checkout', '-b', 'staging'])
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'staging\n')
  git(cwd, ['add', 'file.txt'])
  git(cwd, ['commit', '-m', 'staging'])
  git(cwd, ['checkout', '-b', 'feat', 'main'])
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'feature\n')
  git(cwd, ['add', 'file.txt'])
  git(cwd, ['commit', '-m', 'feat'])
  return cwd
}

describe('sanitizeCommitMessage', () => {
  it('strips markdown fences and blank lines', () => {
    expect(sanitizeCommitMessage('```\nfeat: add git panel\n```')).toBe('feat: add git panel')
  })

  it('keeps at most twelve non-empty lines', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n')
    expect(sanitizeCommitMessage(lines).split('\n')).toHaveLength(12)
  })

  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeCommitMessage('   \n\n  ')).toBe('')
  })
})

describe('parsePrDraftResponse', () => {
  it('reads TITLE and DESCRIPTION labels', () => {
    expect(
      parsePrDraftResponse('TITLE: feat: panel\nDESCRIPTION:\n## Summary\n\nAdds the panel.\n')
    ).toEqual({
      title: 'feat: panel',
      description: '## Summary\n\nAdds the panel.'
    })
  })

  it('falls back to first paragraph as the title', () => {
    expect(parsePrDraftResponse('feat: panel\n\nBody line')).toEqual({
      title: 'feat: panel',
      description: 'Body line'
    })
  })

  it('sanitizes fences and labels', () => {
    expect(sanitizePrTitle('```\nTitle: hello world\n```')).toBe('hello world')
    expect(sanitizePrDescription('Description: ship it')).toBe('ship it')
  })
})

describe('draftPullRequest', () => {
  it('builds a prompt from the base log and diff, omitting secrets', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'export const n = 1\n')
    fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=one\n')
    git(cwd, ['add', 'app.ts', '.env'])
    git(cwd, ['commit', '-m', 'init'])
    git(cwd, ['branch', '-M', 'main'])
    git(cwd, ['checkout', '-b', 'feat/panel'])
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'export const n = 2\n')
    fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=SUPER_SECRET_VALUE\n')
    git(cwd, ['add', 'app.ts', '.env'])
    git(cwd, ['commit', '-m', 'feat: bump'])

    runAiOnce.mockResolvedValue({
      ok: true,
      text: 'TITLE: feat: bump n\nDESCRIPTION:\n## Summary\n\nBump n.\n'
    })
    const draft = await draftPullRequest(cwd, 'claude', undefined, 'main')
    expect(draft).toEqual({
      ok: true,
      title: 'feat: bump n',
      description: '## Summary\n\nBump n.'
    })
    const prompt = String(runAiOnce.mock.calls[0]?.[1] ?? '')
    expect(prompt).toContain('feat: bump')
    expect(prompt).toContain('app.ts')
    expect(prompt).not.toContain('SUPER_SECRET_VALUE')
    expect(prompt).not.toContain('.env')
  })

  it('requires a base branch', async () => {
    const cwd = tmpRepo()
    await expect(draftPullRequest(cwd, 'claude')).resolves.toEqual({
      ok: false,
      error: 'Choose a base branch before generating a pull request.'
    })
  })
})

describe('parseCommitLog', () => {
  it('parses hash, subject, author, and relative time', () => {
    expect(parseCommitLog('a1b2c3d\tfeat: panel\tAda\t2 hours ago')).toEqual([
      { hash: 'a1b2c3d', subject: 'feat: panel', author: 'Ada', when: '2 hours ago' }
    ])
  })

  it('skips malformed lines and fills missing author/when', () => {
    expect(parseCommitLog('deadbeef\n\nabc\tjust a subject\n')).toEqual([
      { hash: 'abc', subject: 'just a subject', author: '', when: '' }
    ])
  })
})

describe('draftCommit', () => {
  it('omits a tracked secret from the AI prompt', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'export const n = 1\n')
    fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=one\n')
    git(cwd, ['add', 'app.ts', '.env'])
    git(cwd, ['commit', '-m', 'init'])
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'export const n = 2\n')
    fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=SUPER_SECRET_VALUE\n')

    runAiOnce.mockResolvedValue({ ok: true, text: 'feat: bump n' })
    const draft = await draftCommit(cwd, 'claude')
    expect(draft.ok).toBe(true)
    expect(draft.files).toEqual(['app.ts'])
    expect(draft.skipped).toEqual(['.env'])
    const prompt = String(runAiOnce.mock.calls[0]?.[1] ?? '')
    expect(prompt).toContain('app.ts')
    expect(prompt).not.toContain('SUPER_SECRET_VALUE')
    expect(prompt).not.toContain('.env')
  })

  it('only sends selected files to the AI prompt', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'a\n')
    fs.writeFileSync(path.join(cwd, 'notes.md'), 'old\n')
    git(cwd, ['add', 'app.ts', 'notes.md'])
    git(cwd, ['commit', '-m', 'init'])
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'b\n')
    fs.writeFileSync(path.join(cwd, 'notes.md'), 'new\n')

    runAiOnce.mockResolvedValue({ ok: true, text: 'feat: update app' })
    const draft = await draftCommit(cwd, 'claude', undefined, ['app.ts'])
    expect(draft.files).toEqual(['app.ts'])
    const prompt = String(runAiOnce.mock.calls[0]?.[1] ?? '')
    expect(prompt).toContain('app.ts')
    expect(prompt).not.toContain('notes.md')
  })
})

describe('commitAll', () => {
  it('leaves previously staged files staged when commit fails', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'kept.ts'), 'a\n')
    fs.writeFileSync(path.join(cwd, 'added.ts'), 'b\n')
    git(cwd, ['add', 'kept.ts', 'added.ts'])
    git(cwd, ['commit', '-m', 'init'])
    fs.writeFileSync(path.join(cwd, 'kept.ts'), 'a2\n')
    fs.writeFileSync(path.join(cwd, 'added.ts'), 'b2\n')
    git(cwd, ['add', 'kept.ts'])

    git(cwd, ['config', 'core.hooksPath', '.git/hooks'])
    const hook = path.join(cwd, '.git', 'hooks', 'pre-commit')
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    fs.chmodSync(hook, 0o755)

    expect(git(cwd, ['diff', '--cached', '--name-only']).trim()).toBe('kept.ts')
    const res = await commitAll(cwd, 'feat: change')
    expect(res.ok).toBe(false)
    expect(res.hookRun).toEqual({ hooks: ['pre-commit'], output: '' })
    expect(git(cwd, ['diff', '--cached', '--name-only']).trim()).toBe('kept.ts')
  })

  it('keeps partial staging exactly when a scoped commit is refused as stale', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'a\n')
    git(cwd, ['add', 'app.ts'])
    git(cwd, ['commit', '-m', 'init'])
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'staged\n')
    git(cwd, ['add', 'app.ts'])
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'working\n')
    const stagedBlob = git(cwd, ['rev-parse', ':app.ts']).trim()

    const res = await commitAll(cwd, 'feat: change', ['app.ts'], { branch: git(cwd, ['branch', '--show-current']).trim(), tree: undefined })
    expect(res.ok).toBe(false)
    expect(git(cwd, ['rev-parse', ':app.ts']).trim()).toBe(stagedBlob)
  })

  it('keeps partial staging of an unselected file when a scoped commit fails in a hook', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'a.ts'), 'a\n')
    fs.writeFileSync(path.join(cwd, 'b.ts'), 'b\n')
    git(cwd, ['add', 'a.ts', 'b.ts'])
    git(cwd, ['commit', '-m', 'init'])
    fs.writeFileSync(path.join(cwd, 'a.ts'), 'staged\n')
    git(cwd, ['add', 'a.ts'])
    fs.writeFileSync(path.join(cwd, 'a.ts'), 'working\n')
    fs.writeFileSync(path.join(cwd, 'b.ts'), 'b2\n')
    const stagedBlob = git(cwd, ['rev-parse', ':a.ts']).trim()
    git(cwd, ['config', 'core.hooksPath', '.git/hooks'])
    const hook = path.join(cwd, '.git', 'hooks', 'pre-commit')
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    fs.chmodSync(hook, 0o755)

    const scope = { branch: git(cwd, ['branch', '--show-current']).trim(), tree: undefined, anyTree: true }
    const res = await commitAll(cwd, 'feat: change', ['b.ts'], scope)
    expect(res.ok).toBe(false)
    expect(git(cwd, ['rev-parse', ':a.ts']).trim()).toBe(stagedBlob)
  })

  it('keeps partial staging of an unselected file when a scoped commit succeeds', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'a.ts'), 'a\n')
    fs.writeFileSync(path.join(cwd, 'b.ts'), 'b\n')
    git(cwd, ['add', 'a.ts', 'b.ts'])
    git(cwd, ['commit', '-m', 'init'])
    fs.writeFileSync(path.join(cwd, 'a.ts'), 'staged\n')
    git(cwd, ['add', 'a.ts'])
    fs.writeFileSync(path.join(cwd, 'a.ts'), 'working\n')
    fs.writeFileSync(path.join(cwd, 'b.ts'), 'b2\n')
    const stagedBlob = git(cwd, ['rev-parse', ':a.ts']).trim()

    const scope = { branch: git(cwd, ['branch', '--show-current']).trim(), tree: undefined, anyTree: true }
    const res = await commitAll(cwd, 'feat: change', ['b.ts'], scope)
    expect(res.ok).toBe(true)
    expect(git(cwd, ['show', '--pretty=', '--name-only', 'HEAD']).trim()).toBe('b.ts')
    expect(git(cwd, ['rev-parse', ':a.ts']).trim()).toBe(stagedBlob)
  })

  it('commits only the selected files and leaves the rest unstaged', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'a\n')
    fs.writeFileSync(path.join(cwd, 'extra.ts'), 'a\n')
    git(cwd, ['add', 'app.ts', 'extra.ts'])
    git(cwd, ['commit', '-m', 'init'])
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'b\n')
    fs.writeFileSync(path.join(cwd, 'extra.ts'), 'b\n')
    git(cwd, ['add', 'extra.ts'])

    const res = await commitAll(cwd, 'feat: change', ['app.ts'])
    expect(res.ok).toBe(true)
    expect(git(cwd, ['show', '--pretty=', '--name-only', 'HEAD']).trim()).toBe('app.ts')
    expect(git(cwd, ['diff', '--cached', '--name-only']).trim()).toBe('')
    expect(git(cwd, ['diff', '--name-only']).trim()).toBe('extra.ts')
  })

  it('restores an unchecked staged file when the commit fails', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'selected.ts'), 'a\n')
    fs.writeFileSync(path.join(cwd, 'unchecked.ts'), 'a\nc\n')
    git(cwd, ['add', 'selected.ts', 'unchecked.ts'])
    git(cwd, ['commit', '-m', 'init'])
    fs.writeFileSync(path.join(cwd, 'selected.ts'), 'b\n')
    fs.writeFileSync(path.join(cwd, 'unchecked.ts'), 'b\nc\n')
    git(cwd, ['add', 'unchecked.ts'])
    fs.writeFileSync(path.join(cwd, 'unchecked.ts'), 'b\nd\n')

    git(cwd, ['config', 'core.hooksPath', '.git/hooks'])
    const hook = path.join(cwd, '.git', 'hooks', 'pre-commit')
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    fs.chmodSync(hook, 0o755)

    const res = await commitAll(cwd, 'feat: change', ['selected.ts'])
    expect(res.ok).toBe(false)
    expect(res.hookRun?.hooks).toEqual(['pre-commit'])
    expect(git(cwd, ['diff', '--cached', '--name-only']).trim()).toBe('unchecked.ts')
    expect(git(cwd, ['diff', '--cached', '--', 'unchecked.ts'])).toContain('+d')
    expect(git(cwd, ['diff', '--', 'unchecked.ts']).trim()).toBe('')
    expect(git(cwd, ['diff', '--name-only']).trim()).toBe('selected.ts')
  })

  it('rejects an empty commit selection', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'a\n')
    git(cwd, ['add', 'app.ts'])
    git(cwd, ['commit', '-m', 'init'])
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'b\n')

    const res = await commitAll(cwd, 'feat: change', [])
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/Select/) })
  })

  it('commits the selection on an unborn HEAD', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'a\n')
    fs.writeFileSync(path.join(cwd, 'extra.ts'), 'a\n')
    git(cwd, ['add', 'app.ts', 'extra.ts'])
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'b\n')

    const res = await commitAll(cwd, 'feat: change', ['app.ts'])
    expect(res.ok).toBe(true)
    expect(git(cwd, ['show', '--pretty=', '--name-only', 'HEAD']).trim()).toBe('app.ts')
    expect(git(cwd, ['diff', '--cached', '--name-only']).trim()).toBe('')
  })
})

describe('operations that overlap on one checkout', () => {
  /** A repo whose `a.txt` and `b.txt` are committed, then both edited. */
  function editedRepo(): string {
    const cwd = tmpRepo()
    fs.mkdirSync(path.join(cwd, 'sub'))
    for (const file of ['a.txt', 'b.txt', 'sub/keep.txt']) fs.writeFileSync(path.join(cwd, file), 'one\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'init'])
    for (const file of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(cwd, file), 'two\n')
    return cwd
  }

  /** Make the first `git commit` wait inside git until `release` is called, as a slow pre-commit hook would. */
  function holdFirstCommit(): { held: () => boolean; release: () => void } {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = false
    execCli.mockImplementation(async (...args: Parameters<typeof realExec.run>) => {
      if (!held && args[2][0] === 'commit') {
        held = true
        await gate
      }
      return realExec.run(...args)
    })
    return { held: () => held, release }
  }

  const calls = (name: string) => execCli.mock.calls.filter(([, , args]) => args[0] === name)
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('run commits one after the other, so neither commits the other\'s files', async () => {
    const cwd = editedRepo()
    const hold = holdFirstCommit()

    const first = commitAll(cwd, 'first', ['a.txt'])
    await vi.waitFor(() => expect(hold.held()).toBe(true))
    const statusRuns = calls('status').length
    const second = commitAll(cwd, 'second', ['b.txt'])
    await wait(150)
    // The second waits for its turn: it has not read the status, let alone touched the index the first is committing.
    expect(calls('status')).toHaveLength(statusRuns)
    expect(calls('add').some(([, , args]) => args.includes('b.txt'))).toBe(false)

    hold.release()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, message: 'first' },
      { ok: true, message: 'second' }
    ])
    expect(git(cwd, ['show', '--name-only', '--format=', 'HEAD~1']).trim()).toBe('a.txt')
    expect(git(cwd, ['show', '--name-only', '--format=', 'HEAD']).trim()).toBe('b.txt')
  })

  it('queue a pull behind a commit on the same checkout, even from a subfolder', async () => {
    const cwd = editedRepo()
    const hold = holdFirstCommit()

    const commit = commitAll(cwd, 'first', ['a.txt'])
    await vi.waitFor(() => expect(hold.held()).toBe(true))
    const statusRuns = calls('status').length
    const pulled = pull(path.join(cwd, 'sub'))
    await wait(150)
    expect(calls('status')).toHaveLength(statusRuns)

    hold.release()
    await expect(pulled).resolves.toEqual({ ok: false, message: 'Set an upstream branch before pulling.' })
    await expect(commit).resolves.toEqual({ ok: true, message: 'first' })
  })

  it('queue a branch switch behind a commit, so the commit lands on the branch it began on', async () => {
    const cwd = editedRepo()
    const start = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    git(cwd, ['branch', 'other'])
    const hold = holdFirstCommit()

    const commit = commitAll(cwd, 'first', ['a.txt'])
    await vi.waitFor(() => expect(hold.held()).toBe(true))
    const switched = checkout(cwd, 'other')
    await wait(150)
    expect(calls('checkout')).toHaveLength(0)

    hold.release()
    await expect(commit).resolves.toEqual({ ok: true, message: 'first' })
    await expect(switched).resolves.toMatchObject({ ok: true })
    expect(git(cwd, ['log', '-1', '--format=%s', start]).trim()).toBe('first')
    expect(git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('other')
  })

  it('does not begin a commit whose turn was stopped while it waited behind another', async () => {
    const cwd = editedRepo()
    const hold = holdFirstCommit()
    const stop = new AbortController()
    const turn = { branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), tree: undefined, signal: stop.signal }

    const first = commitAll(cwd, 'first', ['a.txt'])
    await vi.waitFor(() => expect(hold.held()).toBe(true))
    const second = commitAll(cwd, 'second', ['b.txt'], turn)
    await wait(150)
    stop.abort()

    // The commit that was already running finishes; the one that was still waiting never starts.
    hold.release()
    await expect(first).resolves.toEqual({ ok: true, message: 'first' })
    await expect(second).resolves.toEqual({ ok: false, error: 'Stopped before it began.' })
    expect(git(cwd, ['log', '--format=%s']).trim().split('\n')).toEqual(['first', 'init'])
  })

  it('refuses a push that a queued branch switch left on another branch than the turn began on', async () => {
    const cwd = editedRepo()
    const start = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    git(cwd, ['branch', 'other'])
    const hold = holdFirstCommit()
    const turn = { branch: start, tree: await captureTree(cwd) }

    const commit = commitAll(cwd, 'first', ['a.txt'], turn)
    await vi.waitFor(() => expect(hold.held()).toBe(true))
    const switched = checkout(cwd, 'other')
    await wait(150)
    const pushed = push(cwd, turn)
    await wait(150)

    hold.release()
    await expect(commit).resolves.toEqual({ ok: true, message: 'first' })
    await expect(switched).resolves.toMatchObject({ ok: true })
    await expect(pushed).resolves.toEqual({
      ok: false,
      message: `The checkout moved from ${start} to other, so Farol did not go on.`
    })
    expect(calls('push')).toHaveLength(0)
  })

  it('holds a turn that began on a detached HEAD to it, so a branch switch ahead of the push stops the push', async () => {
    const cwd = editedRepo()
    git(cwd, ['branch', 'other'])
    git(cwd, ['checkout', '--detach'])
    const turn = { branch: undefined, tree: await captureTree(cwd) }

    // While HEAD stays detached the turn goes on: no branch is not a reason to refuse.
    await expect(commitAll(cwd, 'first', ['a.txt'], turn)).resolves.toEqual({ ok: true, message: 'first' })
    await expect(checkout(cwd, 'other')).resolves.toMatchObject({ ok: true })
    await expect(push(cwd, turn)).resolves.toEqual({
      ok: false,
      message: 'The checkout moved from no branch to other, so Farol did not go on.'
    })
    expect(calls('push')).toHaveLength(0)
  })

  it('commits only files as validation saw them: one edited since is refused, and nothing is left staged', async () => {
    const cwd = editedRepo()
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    const tree = await captureTree(cwd)
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'three\n')

    await expect(commitAll(cwd, 'first', ['a.txt', 'b.txt'], { branch, tree })).resolves.toEqual({
      ok: false,
      error: 'These files changed after validation, so Farol did not commit: a.txt.'
    })
    expect(git(cwd, ['diff', '--cached', '--name-only']).trim()).toBe('')
    expect(git(cwd, ['log', '--format=%s']).trim()).toBe('init')
    // b.txt is still as validation saw it, so it goes on when asked for alone.
    await expect(commitAll(cwd, 'second', ['b.txt'], { branch, tree })).resolves.toEqual({ ok: true, message: 'second' })
  })

  it('commits nothing when there is no snapshot of what validation saw', async () => {
    const cwd = editedRepo()
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    await expect(commitAll(cwd, 'first', ['a.txt'], { branch, tree: undefined })).resolves.toMatchObject({ ok: false })
    expect(git(cwd, ['log', '--format=%s']).trim()).toBe('init')
  })

  it('does not hand git a branch name it could read as an option', async () => {
    const cwd = editedRepo()
    for (const branch of ['--orphan=x', '-f', '', '  ']) {
      await expect(checkout(cwd, branch)).resolves.toEqual({ ok: false, message: `"${branch}" is not a branch name.` })
    }
    expect(calls('checkout')).toHaveLength(0)
  })
})

describe('hooksInfo', () => {
  it('reports no hooks for a repo with only samples', async () => {
    const cwd = tmpRepo()
    expect(await hooksInfo(cwd)).toEqual([])
  })

  it('lists an installed executable hook as enabled', async () => {
    const cwd = tmpRepo()
    const hook = path.join(cwd, '.git', 'hooks', 'pre-commit')
    fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(hook, 0o755)

    expect(await hooksInfo(cwd)).toEqual([{ name: 'pre-commit', path: hook, enabled: true }])
  })

  it('lists a non-executable hook as disabled', async () => {
    const cwd = tmpRepo()
    const hook = path.join(cwd, '.git', 'hooks', 'pre-commit')
    fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(hook, 0o644)

    expect(await hooksInfo(cwd)).toEqual([{ name: 'pre-commit', path: hook, enabled: false }])
  })

  it('lists hooks under a tracked core.hooksPath (Husky/lefthook)', async () => {
    const cwd = tmpRepo()
    git(cwd, ['config', 'core.hooksPath', '.husky'])
    const husky = path.join(cwd, '.husky')
    fs.mkdirSync(husky)
    const hook = path.join(husky, 'pre-commit')
    fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(hook, 0o755)

    expect(await hooksInfo(cwd)).toEqual([{ name: 'pre-commit', path: hook, enabled: true }])
  })
})

describe('syncManagedHooks', () => {
  const runtime = { execPath: '/usr/bin/farol', scriptPath: '/app/git-hook.js', socketPath: '/tmp/farol-test.sock' }
  const pipeline = (id: string, gitHooks: Pipeline['gitHooks']): Pipeline => ({ id, name: id, nodes: [], gitHooks })

  it('installs a pre-commit script for a pipeline configured with that hook', async () => {
    const cwd = tmpRepo()
    await syncManagedHooks(cwd, [pipeline('lint', ['pre-commit'])], runtime)

    const info = await hooksInfo(cwd)
    expect(info).toEqual([{ name: 'pre-commit', path: path.join(cwd, '.git', 'hooks', 'pre-commit'), enabled: true }])
    const script = fs.readFileSync(info[0]!.path, 'utf8')
    expect(script).toContain(runtime.socketPath)
    expect(script).toContain(runtime.execPath)
    expect(script).toContain('pre-commit')
  })

  it('does not overwrite a hand-written hook', async () => {
    const cwd = tmpRepo()
    const hook = path.join(cwd, '.git', 'hooks', 'pre-commit')
    fs.writeFileSync(hook, '#!/bin/sh\necho mine\n')
    fs.chmodSync(hook, 0o755)

    await syncManagedHooks(cwd, [pipeline('lint', ['pre-commit'])], runtime)

    expect(fs.readFileSync(hook, 'utf8')).toBe('#!/bin/sh\necho mine\n')
  })

  it('removes a previously managed hook once no pipeline wants it', async () => {
    const cwd = tmpRepo()
    await syncManagedHooks(cwd, [pipeline('lint', ['pre-commit'])], runtime)
    const hook = path.join(cwd, '.git', 'hooks', 'pre-commit')
    expect(fs.existsSync(hook)).toBe(true)

    await syncManagedHooks(cwd, [pipeline('lint', [])], runtime)
    expect(fs.existsSync(hook)).toBe(false)
  })

  it('refuses a core.hooksPath that points inside the tracked worktree', async () => {
    const cwd = tmpRepo()
    git(cwd, ['config', 'core.hooksPath', '.husky'])
    const husky = path.join(cwd, '.husky')
    fs.mkdirSync(husky)

    await syncManagedHooks(cwd, [pipeline('lint', ['pre-commit'])], runtime)

    expect(fs.existsSync(path.join(husky, 'pre-commit'))).toBe(false)
    expect(await hooksInfo(cwd)).toEqual([])
  })

  it('does not delete a farol-managed hook that sits under a tracked hooksPath', async () => {
    const cwd = tmpRepo()
    git(cwd, ['config', 'core.hooksPath', '.husky'])
    const husky = path.join(cwd, '.husky')
    fs.mkdirSync(husky)
    const hook = path.join(husky, 'pre-commit')
    fs.writeFileSync(hook, '#!/bin/sh\n# farol-managed-hook\nexit 0\n')
    fs.chmodSync(hook, 0o755)

    await syncManagedHooks(cwd, [pipeline('lint', [])], runtime)

    expect(fs.existsSync(hook)).toBe(true)
  })

  it('installs into the shared hooks dir when run from a linked worktree', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'a\n')
    git(cwd, ['add', 'file.txt'])
    git(cwd, ['commit', '-m', 'init'])
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-git-wt-'))
    fs.rmdirSync(worktree)
    dirs.push(worktree)
    git(cwd, ['worktree', 'add', '-b', 'feat', worktree])

    await syncManagedHooks(worktree, [pipeline('lint', ['pre-commit'])], runtime)

    const hook = path.join(cwd, '.git', 'hooks', 'pre-commit')
    expect(fs.existsSync(hook)).toBe(true)
    expect(await hooksInfo(worktree)).toEqual([{ name: 'pre-commit', path: hook, enabled: true }])
  })
})

describe('push blocked by a hook', () => {
  it('reports the pre-push hook and its output', async () => {
    const origin = tmpRepo()
    fs.writeFileSync(path.join(origin, 'file.txt'), 'base\n')
    git(origin, ['add', 'file.txt'])
    git(origin, ['commit', '-m', 'init'])
    git(origin, ['branch', '-M', 'main'])
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-git-'))
    dirs.push(cwd)
    execFileSync('git', ['clone', origin, cwd], { encoding: 'utf8' })
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
    fs.writeFileSync(path.join(cwd, 'feat.txt'), 'new\n')
    git(cwd, ['add', 'feat.txt'])
    git(cwd, ['commit', '-m', 'feat'])

    const hook = path.join(cwd, '.git', 'hooks', 'pre-push')
    fs.writeFileSync(hook, '#!/bin/sh\necho "no pushing today" >&2\nexit 1\n')
    fs.chmodSync(hook, 0o755)

    const res = await push(cwd)
    expect(res.ok).toBe(false)
    expect(res.hookRun?.hooks).toEqual(['pre-push'])
    expect(res.hookRun?.output).toContain('no pushing today')
  })
})

describe('mergeBaseConflicts', () => {
  it('detects a conflict with staging', async () => {
    await expect(mergeBaseConflicts(conflictRepo())).resolves.toEqual({ base: 'staging', conflicts: true })
  })

  it('reports a clean merge with staging', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'base\n')
    git(cwd, ['add', 'file.txt'])
    git(cwd, ['commit', '-m', 'init'])
    git(cwd, ['branch', '-M', 'main'])
    git(cwd, ['checkout', '-b', 'staging'])
    fs.writeFileSync(path.join(cwd, 'other.txt'), 'staging only\n')
    git(cwd, ['add', 'other.txt'])
    git(cwd, ['commit', '-m', 'staging'])
    git(cwd, ['checkout', '-b', 'feat', 'main'])
    fs.writeFileSync(path.join(cwd, 'new.txt'), 'feature only\n')
    git(cwd, ['add', 'new.txt'])
    git(cwd, ['commit', '-m', 'feat'])
    await expect(mergeBaseConflicts(cwd)).resolves.toEqual({ base: 'staging', conflicts: false })
    await expect(mergeBaseConflicts(cwd, 'main')).resolves.toEqual({ base: 'main', conflicts: false })
    await expect(mergeBaseConflicts(cwd, 'feat')).resolves.toBeUndefined()
  })

  it('checks the selected base instead of staging', async () => {
    const cwd = conflictRepo()
    git(cwd, ['branch', 'other', 'HEAD'])
    await expect(mergeBaseConflicts(cwd, 'other')).resolves.toEqual({ base: 'other', conflicts: false })
    await expect(status(cwd, 'other')).resolves.toMatchObject({ baseMerge: { base: 'other', conflicts: false } })
  })

  it('skips when HEAD is staging', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'base\n')
    git(cwd, ['add', 'file.txt'])
    git(cwd, ['commit', '-m', 'init'])
    git(cwd, ['checkout', '-b', 'staging'])
    await expect(mergeBaseConflicts(cwd)).resolves.toBeUndefined()
  })
})

describe('mergeForConflicts', () => {
  it('writes conflict markers so the agent can edit them', async () => {
    const cwd = conflictRepo()
    const merged = await mergeForConflicts(cwd, 'staging')
    expect(merged).toMatchObject({ ok: true, files: ['file.txt'] })
    expect(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8')).toMatch(/<<<<<<</)
  })

  it('refuses to merge on a dirty tree', async () => {
    const cwd = conflictRepo()
    fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'nope\n')
    await expect(mergeForConflicts(cwd, 'staging')).resolves.toMatchObject({ ok: false })
  })

  it('does not fetch a base that git could read as an option or a refspec', async () => {
    const cwd = conflictRepo()
    for (const base of ['--upload-pack=touch /tmp/pwned', 'staging:main', '+staging']) {
      await expect(mergeForConflicts(cwd, base)).resolves.toEqual({
        ok: false,
        message: `"${base}" is not a valid branch name.`,
        files: []
      })
    }
    expect(execCli.mock.calls.some(([, , args]) => args[0] === 'fetch')).toBe(false)
  })

  it('merges origin/staging even when the local staging branch would not conflict', async () => {
    const origin = tmpRepo()
    fs.writeFileSync(path.join(origin, 'file.txt'), 'base\n')
    git(origin, ['add', 'file.txt'])
    git(origin, ['commit', '-m', 'init'])
    git(origin, ['branch', '-M', 'main'])
    git(origin, ['checkout', '-b', 'staging'])
    fs.writeFileSync(path.join(origin, 'file.txt'), 'origin-staging\n')
    git(origin, ['add', 'file.txt'])
    git(origin, ['commit', '-m', 'staging'])
    git(origin, ['checkout', 'main'])

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-git-'))
    dirs.push(cwd)
    execFileSync('git', ['clone', origin, cwd], { encoding: 'utf8' })
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
    git(cwd, ['config', 'commit.gpgsign', 'false'])
    git(cwd, ['checkout', '-b', 'feat'])
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'feature\n')
    git(cwd, ['add', 'file.txt'])
    git(cwd, ['commit', '-m', 'feat'])
    git(cwd, ['branch', 'staging', 'main'])

    const merged = await mergeForConflicts(cwd, 'staging')
    expect(merged).toMatchObject({ ok: true, files: ['file.txt'] })
    expect(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8')).toMatch(/origin-staging/)
  })
})

describe('status and push without upstream', () => {
  function cloneRepo(): string {
    const origin = tmpRepo()
    fs.writeFileSync(path.join(origin, 'file.txt'), 'base\n')
    git(origin, ['add', 'file.txt'])
    git(origin, ['commit', '-m', 'init'])
    git(origin, ['branch', '-M', 'main'])
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-git-'))
    dirs.push(cwd)
    execFileSync('git', ['clone', origin, cwd], { encoding: 'utf8' })
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
    git(cwd, ['config', 'commit.gpgsign', 'false'])
    return cwd
  }

  it('counts unpublished commits and publishes the branch with -u', async () => {
    const cwd = cloneRepo()
    git(cwd, ['checkout', '-b', 'feat'])
    fs.writeFileSync(path.join(cwd, 'feat.txt'), 'new\n')
    git(cwd, ['add', 'feat.txt'])
    git(cwd, ['commit', '-m', 'feat'])

    await expect(status(cwd)).resolves.toMatchObject({
      upstream: false,
      ahead: 1,
      remote: 'origin'
    })
    await expect(push(cwd)).resolves.toMatchObject({ ok: true })
    await expect(status(cwd)).resolves.toMatchObject({ upstream: true, ahead: 0 })
  })

  it('holds a branch switch until the push is done, so the push publishes the branch it began on', async () => {
    const cwd = cloneRepo()
    const origin = git(cwd, ['remote', 'get-url', 'origin']).trim()
    git(cwd, ['checkout', '-b', 'feat'])
    fs.writeFileSync(path.join(cwd, 'feat.txt'), 'new\n')
    git(cwd, ['add', 'feat.txt'])
    git(cwd, ['commit', '-m', 'feat'])
    git(cwd, ['branch', 'other', 'main'])
    // The push has read its branch and now waits for the GitHub credentials, as a slow token refresh would make it.
    let release!: () => void
    const credentials = new Promise<void>((resolve) => {
      release = resolve
    })
    githubGitEnv.mockReturnValue(credentials)

    const pushed = push(cwd)
    await vi.waitFor(() => expect(githubGitEnv).toHaveBeenCalled())
    const switched = checkout(cwd, 'other')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(execCli.mock.calls.some(([, , args]) => args[0] === 'checkout')).toBe(false)

    release()
    await expect(pushed).resolves.toMatchObject({ ok: true })
    await expect(switched).resolves.toMatchObject({ ok: true })
    expect(git(origin, ['branch', '--list', 'feat', 'other']).trim()).toBe('feat')
  })

  describe('with a GitHub token', () => {
    const TOKEN_ENV = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: 'Authorization: Basic c2VjcmV0'
    }

    function branchAhead(): string {
      const cwd = cloneRepo()
      git(cwd, ['checkout', '-b', 'feat'])
      fs.writeFileSync(path.join(cwd, 'feat.txt'), 'new\n')
      git(cwd, ['add', 'feat.txt'])
      git(cwd, ['commit', '-m', 'feat'])
      return cwd
    }

    const pushes = () => execCli.mock.calls.filter(([, , args]) => args[0] === 'push')

    it('signs the push in through the environment and keeps the token off the command line', async () => {
      githubGitEnv.mockResolvedValue(TOKEN_ENV)
      await expect(push(branchAhead())).resolves.toMatchObject({ ok: true })
      expect(pushes()).toHaveLength(1)
      const [, , args, , env] = pushes()[0]!
      expect(args.join(' ')).not.toContain('c2VjcmV0')
      expect(env).toEqual(TOKEN_ENV)
    })

    /** A `pre-push` hook in `cwd` running `body`. */
    function prePushHook(cwd: string, body: string): string {
      const hook = path.join(cwd, '.git', 'hooks', 'pre-push')
      fs.writeFileSync(hook, `#!/bin/sh\n${body}\n`)
      fs.chmodSync(hook, 0o755)
      return hook
    }

    /** Every run that carries the token fails as git does when GitHub refuses a login. */
    function githubRefusesToken(): void {
      execCli.mockImplementation((...args: Parameters<typeof realExec.run>) =>
        args[4]
          ? Promise.resolve({ code: 128, out: '', err: "fatal: Authentication failed for 'https://github.com/acme/repo.git/'" })
          : realExec.run(...args)
      )
    }

    it('pushes again with the machine\'s own credentials when GitHub refuses the token, with the hooks on', async () => {
      githubGitEnv.mockResolvedValue(TOKEN_ENV)
      githubRefusesToken()
      const cwd = branchAhead()
      const log = path.join(cwd, 'hook.log')
      prePushHook(cwd, `echo ran >> '${log}'`)

      await expect(push(cwd)).resolves.toMatchObject({ ok: true })

      expect(pushes().map(([, , args, , env]) => [args, env])).toEqual([
        [['push', '-u', 'origin', 'HEAD'], TOKEN_ENV],
        [['push', '-u', 'origin', 'HEAD'], undefined]
      ])
      // The refused run never reached the hook; the second one ran it, once.
      expect(fs.readFileSync(log, 'utf8')).toBe('ran\n')
    })

    it('does not push again when a hook blocks the push, whatever its output says', async () => {
      githubGitEnv.mockResolvedValue(TOKEN_ENV)
      const cwd = branchAhead()
      prePushHook(cwd, 'echo "authentication failed in the test suite" >&2\nexit 1')

      const res = await push(cwd)

      expect(res.ok).toBe(false)
      expect(res.hookRun?.hooks).toEqual(['pre-push'])
      expect(pushes()).toHaveLength(1)
    })

    it('reports a failure that is not about credentials without trying again', async () => {
      githubGitEnv.mockResolvedValue(TOKEN_ENV)
      execCli.mockImplementation((...args: Parameters<typeof realExec.run>) =>
        args[4]
          ? Promise.resolve({ code: 1, out: '', err: 'error: failed to push some refs' })
          : realExec.run(...args)
      )
      await expect(push(branchAhead())).resolves.toMatchObject({ ok: false, message: 'error: failed to push some refs' })
      expect(pushes()).toHaveLength(1)
    })
  })

  it('refuses push when the repo has no remotes', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'base\n')
    git(cwd, ['add', 'file.txt'])
    git(cwd, ['commit', '-m', 'init'])
    const st = await status(cwd)
    expect(st).toMatchObject({ upstream: false, ahead: 1 })
    expect(st.remote).toBeUndefined()
    await expect(push(cwd)).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/remote/) })
  })

  it('pulls the current tracking branch from origin', async () => {
    const cwd = cloneRepo()
    const origin = git(cwd, ['remote', 'get-url', 'origin']).trim()
    fs.writeFileSync(path.join(origin, 'remote.txt'), 'from origin\n')
    git(origin, ['add', 'remote.txt'])
    git(origin, ['commit', '-m', 'remote update'])

    await expect(pull(cwd)).resolves.toMatchObject({ ok: true })
    expect(fs.readFileSync(path.join(cwd, 'remote.txt'), 'utf8')).toBe('from origin\n')
  })

  it('refuses to pull with local changes', async () => {
    const cwd = cloneRepo()
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'local change\n')

    await expect(pull(cwd)).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/commit or stash/i)
    })
  })

  it('refuses divergent history without creating a merge commit', async () => {
    const cwd = cloneRepo()
    const origin = git(cwd, ['remote', 'get-url', 'origin']).trim()
    fs.writeFileSync(path.join(cwd, 'local.txt'), 'local\n')
    git(cwd, ['add', 'local.txt'])
    git(cwd, ['commit', '-m', 'local update'])
    fs.writeFileSync(path.join(origin, 'remote.txt'), 'remote\n')
    git(origin, ['add', 'remote.txt'])
    git(origin, ['commit', '-m', 'remote update'])

    await expect(pull(cwd)).resolves.toMatchObject({ ok: false })
    expect(git(cwd, ['log', '-1', '--format=%s']).trim()).toBe('local update')
  })
})

describe('githubStatus', () => {
  it('attaches predicted conflict paths for a conflicting pull request', async () => {
    const cwd = conflictRepo()
    githubInfo.mockResolvedValue({
      available: true,
      prs: [{ number: 7, hasConflicts: true, base: 'staging' }]
    })
    await expect(githubStatus(cwd)).resolves.toMatchObject({
      conflictFiles: ['file.txt']
    })
  })
})

describe('bringPrConflicts', () => {
  it('merges a conflicting pull request on a clean tree and returns a prompt', async () => {
    const cwd = conflictRepo()
    githubInfo.mockResolvedValue({
      available: true,
      prs: [{ number: 7, hasConflicts: true, base: 'staging' }]
    })
    const res = await bringPrConflicts(cwd)
    expect(res).toMatchObject({ ok: true, message: 'Merged staging with conflicts.' })
    expect(res.prompt).toMatch(/Pull request #7/)
    expect(res.prompt).toMatch(/file\.txt/)
    expect(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8')).toMatch(/<<<<<<</)
  })

  it('merges staging when the open pull request itself is clean', async () => {
    const cwd = conflictRepo()
    githubInfo.mockResolvedValue({
      available: true,
      prs: [{ number: 7, hasConflicts: false, base: 'main' }]
    })
    const res = await bringPrConflicts(cwd)
    expect(res.ok).toBe(true)
    expect(res.prompt).toMatch(/staging/)
    expect(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8')).toMatch(/<<<<<<</)
  })

  it('reuses markers already in the working tree', async () => {
    const cwd = conflictRepo()
    await mergeForConflicts(cwd, 'staging')
    githubInfo.mockResolvedValue({
      available: true,
      prs: [{ number: 7, hasConflicts: true, base: 'staging' }]
    })
    const res = await bringPrConflicts(cwd)
    expect(res).toMatchObject({ ok: true, message: 'Conflicts are already in the working tree.' })
    expect(res.prompt).toMatch(/Pull request #7/)
    expect(res.prompt).toMatch(/file\.txt/)
  })

  it('refuses a dirty tree when the pull request still needs a merge', async () => {
    const cwd = conflictRepo()
    fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'nope\n')
    githubInfo.mockResolvedValue({
      available: true,
      prs: [{ number: 7, hasConflicts: true, base: 'staging' }]
    })
    await expect(bringPrConflicts(cwd)).resolves.toMatchObject({
      ok: false,
      message: 'Commit or stash local changes before merging the pull request base.'
    })
  })

  it('does nothing when there is no pull request conflict', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'base\n')
    git(cwd, ['add', 'file.txt'])
    git(cwd, ['commit', '-m', 'init'])
    await expect(bringPrConflicts(cwd)).resolves.toEqual({
      ok: false,
      message: 'No pull request conflicts to resolve.'
    })
  })
})
