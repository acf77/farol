import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runAiOnce, githubInfo } = vi.hoisted(() => ({
  runAiOnce: vi.fn(),
  githubInfo: vi.fn()
}))
vi.mock('./ai-oneshot', () => ({ runAiOnce }))
vi.mock('./github', () => ({ githubInfo }))

import { bringPrConflicts, commitAll, draftCommit, githubStatus, mergeBaseConflicts, mergeForConflicts, parseCommitLog, push, sanitizeCommitMessage, status } from './git'

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
})

afterEach(() => {
  runAiOnce.mockReset()
  githubInfo.mockReset()
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
    expect(git(cwd, ['diff', '--cached', '--name-only']).trim()).toBe('kept.ts')
  })

  it('refuses to commit when the draft file set is stale', async () => {
    const cwd = tmpRepo()
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'a\n')
    git(cwd, ['add', 'app.ts'])
    git(cwd, ['commit', '-m', 'init'])
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'b\n')
    fs.writeFileSync(path.join(cwd, 'extra.ts'), 'c\n')

    const res = await commitAll(cwd, 'feat: change', ['app.ts'])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/changed/)
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
