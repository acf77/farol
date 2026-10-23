import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureTree, pinTree, releaseTrees, restoreTree, treeDiffStat, undoChange } from './delegate-snapshot'

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

const read = (name: string) => fs.readFileSync(path.join(repo, name), 'utf8')
const write = (name: string, text: string) => fs.writeFileSync(path.join(repo, name), text)

describe('undoChange', () => {
  async function subagentRun(change: () => void) {
    const before = (await captureTree(repo))!
    change()
    return { before, after: (await captureTree(repo))! }
  }

  it('reverses edits, new files, deletions and binary files, and nothing else', async () => {
    write('keep.txt', 'mine\n')
    fs.writeFileSync(path.join(repo, 'img.bin'), Buffer.from([0, 1, 2, 3]))
    const { before, after } = await subagentRun(() => {
      write('a.txt', 'changed\n')
      write('new.txt', 'new\n')
      fs.rmSync(path.join(repo, 'keep.txt'))
      fs.writeFileSync(path.join(repo, 'img.bin'), Buffer.from([9, 9]))
    })
    expect(await undoChange(repo, before, after)).toEqual({ ok: true })
    expect(read('a.txt')).toBe('one\n')
    expect(fs.existsSync(path.join(repo, 'new.txt'))).toBe(false)
    expect(read('keep.txt')).toBe('mine\n')
    expect([...fs.readFileSync(path.join(repo, 'img.bin'))]).toEqual([0, 1, 2, 3])
    expect(git('diff', '--cached', '--name-only')).toBe('')
  })

  it('keeps a later edit that does not overlap', async () => {
    write('a.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n')
    const { before, after } = await subagentRun(() => write('a.txt', 'L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n'))
    write('a.txt', 'L1\nl2\nl3\nl4\nl5\nl6\nl7\nL8\n')
    write('later.txt', 'later\n')
    expect(await undoChange(repo, before, after)).toEqual({ ok: true })
    expect(read('a.txt')).toBe('l1\nl2\nl3\nl4\nl5\nl6\nl7\nL8\n')
    expect(read('later.txt')).toBe('later\n')
  })

  it('changes nothing when a later edit overlaps, and can restore instead', async () => {
    const { before, after } = await subagentRun(() => write('a.txt', 'subagent\n'))
    write('a.txt', 'developer\n')
    write('later.txt', 'later\n')

    const outcome = await undoChange(repo, before, after)
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.restoreFiles).toBe(2)
    expect(read('a.txt')).toBe('developer\n')

    await restoreTree(repo, before)
    expect(read('a.txt')).toBe('one\n')
    expect(fs.existsSync(path.join(repo, 'later.txt'))).toBe(false)
  })
})

describe('pinned snapshots', () => {
  it('survive until the chat releases them, whatever the ids contain', async () => {
    const tree = (await captureTree(repo))!
    await pinTree(repo, 'task/1 x', 'task/1 x:d1', 'before', tree)
    await pinTree(repo, 'other', 'other:d1', 'before', tree)
    expect(git('for-each-ref', '--format=%(refname)', 'refs/farol/')).toContain('refs/farol/delegate/task-1-x/task-1-x-d1/before')

    await releaseTrees(repo, 'task/1 x')
    const left = git('for-each-ref', '--format=%(refname)', 'refs/farol/')
    expect(left).not.toContain('task-1-x')
    expect(left).toContain('refs/farol/delegate/other/')
  })
})
