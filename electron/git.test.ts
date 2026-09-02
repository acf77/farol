import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { runAiOnce } = vi.hoisted(() => ({
  runAiOnce: vi.fn()
}))
vi.mock('./ai-oneshot', () => ({ runAiOnce }))

import { commitAll, draftCommit, parseCommitLog, sanitizeCommitMessage } from './git'

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

afterEach(() => {
  runAiOnce.mockReset()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

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
