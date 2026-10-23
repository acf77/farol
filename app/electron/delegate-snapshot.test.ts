import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureTree, treeDiffStat } from './delegate-snapshot'

let repo: string
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-snap-test-'))
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n')
  git('add', '.')
  git('commit', '-qm', 'init')
})

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

describe('captureTree', () => {
  it('sees edits and untracked files but not ignored ones, leaving the real index alone', async () => {
    const before = await captureTree(repo)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n')
    fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n')
    fs.mkdirSync(path.join(repo, 'ignored'))
    fs.writeFileSync(path.join(repo, 'ignored', 'x.txt'), 'x\n')
    const after = await captureTree(repo)

    const stat = await treeDiffStat(repo, before!, after!)
    expect(stat).toContain('a.txt')
    expect(stat).toContain('new.txt')
    expect(stat).not.toContain('ignored')
    expect(git('status', '--porcelain')).toContain('?? new.txt')
    expect(git('diff', '--cached', '--name-only')).toBe('')
  })

  it('reports no change when nothing changed', async () => {
    const before = await captureTree(repo)
    expect(await treeDiffStat(repo, before!, (await captureTree(repo))!)).toBe('')
  })

  it('sees deletions and works from a subdirectory', async () => {
    fs.mkdirSync(path.join(repo, 'sub'))
    const before = await captureTree(path.join(repo, 'sub'))
    fs.rmSync(path.join(repo, 'a.txt'))
    const after = await captureTree(path.join(repo, 'sub'))
    expect(await treeDiffStat(repo, before!, after!)).toContain('a.txt')
  })

  it('returns undefined outside a git checkout', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-plain-'))
    try {
      expect(await captureTree(plain)).toBeUndefined()
    } finally {
      fs.rmSync(plain, { recursive: true, force: true })
    }
  })
})
