import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listTurns,
  pruneCheckpoints,
  releaseCheckpoints,
  revertToTurn,
  startTurn,
  turnPreview,
  CHECKPOINT_MAX_FILE_BYTES
} from './checkpoints'
import { captureLimited } from './delegate-snapshot'

let repo: string
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
const read = (name: string): string => fs.readFileSync(path.join(repo, name), 'utf8')
const write = (name: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
  fs.writeFileSync(path.join(repo, name), text)
}
const exists = (name: string): boolean => fs.existsSync(path.join(repo, name))
const capture = async () => (await captureLimited(repo, CHECKPOINT_MAX_FILE_BYTES))!

/** A turn as Chat records it: a snapshot, the agent's changes, a snapshot. */
async function runTurn(change: () => void, prompt = 'do it', taskId = 'chat-1', limit?: number): Promise<void> {
  const record = startTurn(repo, taskId, await capture(), prompt)
  change()
  await record.finish(await capture(), limit)
}

/** The user's git state that a checkpoint must leave alone. Working files are meant to change. */
function gitState(): Record<string, string> {
  return {
    head: git('rev-parse', 'HEAD'),
    branches: git('branch', '-a'),
    reflog: git('reflog', '--all'),
    stash: git('stash', 'list'),
    index: git('ls-files', '--stage'),
    log: git('log', '--all', '--oneline')
  }
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-ckpt-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  write('a.txt', 'one\n')
  write('.gitignore', 'ignored/\n')
  git('add', '.')
  git('commit', '-qm', 'init')
})

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

describe('checkpoints', () => {
  it('leave the index, HEAD, branches, stash and reflog alone', async () => {
    write('staged.txt', 'staged\n')
    git('add', 'staged.txt')
    write('a.txt', 'edited\n')
    const before = gitState()
    await runTurn(() => {
      write('a.txt', 'agent\n')
      write('new.txt', 'new\n')
    })
    expect(gitState()).toEqual(before)
  })

  it('capture untracked files, skip ignored ones, and list what the turn changed', async () => {
    await runTurn(() => {
      write('a.txt', 'two\nthree\n')
      write('new.txt', 'new\n')
      write('ignored/x.txt', 'x\n')
    })
    const [turn] = await listTurns(repo, 'chat-1')
    expect(turn).toMatchObject({ turn: 1, kind: 'turn', prompt: 'do it', done: true, changed: true, fileCount: 2 })
    expect(turn.files).toEqual(
      expect.arrayContaining([
        { path: 'a.txt', added: 2, removed: 1 },
        { path: 'new.txt', added: 1, removed: 0 }
      ])
    )
    expect(turn.files.some((file) => file.path.startsWith('ignored'))).toBe(false)
  })

  it('store a turn that changed nothing without a second tree', async () => {
    await runTurn(() => undefined)
    const [turn] = await listTurns(repo, 'chat-1')
    expect(turn).toMatchObject({ done: true, changed: false, fileCount: 0 })
    const ref = 'refs/farol/checkpoints/chat-1/000001'
    expect(git('rev-parse', '--verify', `${ref}:before`).trim()).toMatch(/^[0-9a-f]{40}$/)
    expect(() => git('rev-parse', '--verify', '--quiet', `${ref}:after`)).toThrow()
  })

  it('stay in the private ref namespace and out of branch, log and push', async () => {
    await runTurn(() => write('new.txt', 'new\n'))
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-remote-'))
    try {
      execFileSync('git', ['init', '-q', '--bare', remote])
      git('remote', 'add', 'origin', remote)
      git('push', '-q', 'origin', 'main')
      git('push', '-q', '--all', 'origin')
      expect(git('ls-remote', 'origin')).not.toContain('farol')
    } finally {
      fs.rmSync(remote, { recursive: true, force: true })
    }
    expect(git('for-each-ref', '--format=%(refname)').split('\n').filter(Boolean)).toEqual([
      'refs/farol/checkpoints/chat-1/000001',
      'refs/heads/main',
      'refs/remotes/origin/main'
    ])
    expect(git('branch', '-a')).not.toContain('farol')
    expect(git('log', '--all', '--oneline').trim().split('\n')).toHaveLength(1)
  })

  it('leave files over the size limit out and name them', async () => {
    write('big.bin', 'x'.repeat(2000))
    write('small.txt', 'small\n')
    const snap = (await captureLimited(repo, 1000))!
    expect(snap.skipped).toEqual(['big.bin'])
    const files = git('ls-tree', '-r', '--name-only', snap.tree)
    expect(files).toContain('small.txt')
    expect(files).not.toContain('big.bin')
    expect(git('status', '--porcelain')).toContain('big.bin')
  })

  it('prune the oldest turns past the limit, and drop a chat on release', async () => {
    for (let i = 0; i < 5; i++) await runTurn(() => write(`f${i}.txt`, `${i}\n`), `turn ${i}`, 'chat-1', 3)
    await runTurn(() => write('other.txt', 'o\n'), 'other', 'chat-2')
    expect((await listTurns(repo, 'chat-1')).map((turn) => turn.turn)).toEqual([3, 4, 5])

    expect(await pruneCheckpoints(repo, ['chat-1'])).toBe(1)
    expect(await listTurns(repo, 'chat-2')).toEqual([])
    await releaseCheckpoints(repo, 'chat-1')
    expect(git('for-each-ref', 'refs/farol/')).toBe('')
  })

  it('number a chat past the turns already saved, and survive odd chat ids', async () => {
    await runTurn(() => write('a1.txt', '1\n'), 'first', 'chat/1 x')
    await runTurn(() => write('a2.txt', '2\n'), 'second', 'chat/1 x')
    expect((await listTurns(repo, 'chat/1 x')).map((turn) => turn.prompt)).toEqual(['first', 'second'])
    expect(git('for-each-ref', '--format=%(refname)')).toContain('refs/farol/checkpoints/chat-1-x/000002')
  })
})

describe('turnPreview', () => {
  it('drops Farol notes and the request prefix, and shortens long text', () => {
    expect(turnPreview('Note from Farol: undone.\n\nUser request: fix   the\nbug')).toBe('fix the bug')
    expect(turnPreview('x'.repeat(300))).toHaveLength(120)
  })
})

describe('revertToTurn', () => {
  it('restores the exact tree, removes files added later, and saves a safety checkpoint first', async () => {
    await runTurn(() => write('one.txt', '1\n'), 'turn one')
    const afterOne = (await capture()).tree
    await runTurn(() => {
      write('a.txt', 'changed\n')
      write('two.txt', '2\n')
    }, 'turn two')
    await runTurn(() => {
      write('three.txt', '3\n')
      fs.rmSync(path.join(repo, 'one.txt'))
    }, 'turn three')
    const afterThree = (await capture()).tree
    const state = gitState()

    expect(await revertToTurn(repo, 'chat-1', 2)).toMatchObject({ ok: true, fileCount: 4 })

    expect((await capture()).tree).toBe(afterOne)
    expect(read('a.txt')).toBe('one\n')
    expect(exists('two.txt') || exists('three.txt')).toBe(false)
    expect(read('one.txt')).toBe('1\n')
    expect(gitState()).toEqual(state)

    const turns = await listTurns(repo, 'chat-1')
    const safety = turns[turns.length - 1]
    expect(safety).toMatchObject({ turn: 4, kind: 'revert', prompt: 'Revert to before turn 2', done: true, changed: true })
    expect(git('rev-parse', 'refs/farol/checkpoints/chat-1/000004:before').trim()).toBe(afterThree)
  })

  it('can be undone by reverting to the safety checkpoint', async () => {
    await runTurn(() => write('a.txt', 'turn one\n'))
    await runTurn(() => write('b.txt', 'turn two\n'))
    const final = (await capture()).tree
    await revertToTurn(repo, 'chat-1', 1)
    expect(read('a.txt')).toBe('one\n')
    expect(exists('b.txt')).toBe(false)

    expect(await revertToTurn(repo, 'chat-1', 3)).toMatchObject({ ok: true })
    expect((await capture()).tree).toBe(final)
  })

  it('leaves files over the size limit alone', async () => {
    await runTurn(() => write('a.txt', 'agent\n'))
    write('big.bin', 'x'.repeat(CHECKPOINT_MAX_FILE_BYTES + 1))
    await revertToTurn(repo, 'chat-1', 1)
    expect(read('a.txt')).toBe('one\n')
    expect(exists('big.bin')).toBe(true)
  })

  it('refuses a turn that is gone, outside git, and changes nothing', async () => {
    write('a.txt', 'mine\n')
    expect(await revertToTurn(repo, 'chat-1', 9)).toEqual({ ok: false, message: 'This turn is no longer saved.' })
    expect(read('a.txt')).toBe('mine\n')
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-plain-'))
    try {
      expect(await listTurns(plain, 'chat-1')).toEqual([])
    } finally {
      fs.rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('three turns, a revert, and its undo', () => {
  it('diffs each turn on its own and walks the files back and forth', async () => {
    const states: string[] = [(await capture()).tree]
    const steps: Array<[string, () => void]> = [
      ['add a feature', () => write('feature.ts', 'export const x = 1\n')],
      ['edit and add docs', () => { write('feature.ts', 'export const x = 2\nexport const y = 3\n'); write('docs.md', 'docs\n') }],
      ['remove the feature', () => fs.rmSync(path.join(repo, 'feature.ts'))]
    ]
    const state = gitState()
    for (const [prompt, change] of steps) {
      await runTurn(change, prompt)
      states.push((await capture()).tree)
    }

    const turns = await listTurns(repo, 'chat-1')
    expect(turns.map((turn) => [turn.prompt, turn.files.map((file) => `${file.path} +${file.added} -${file.removed}`).sort()])).toEqual([
      ['add a feature', ['feature.ts +1 -0']],
      ['edit and add docs', ['docs.md +1 -0', 'feature.ts +2 -1']],
      ['remove the feature', ['feature.ts +0 -2']]
    ])

    await revertToTurn(repo, 'chat-1', 2)
    expect((await capture()).tree).toBe(states[1])
    expect(read('feature.ts')).toBe('export const x = 1\n')
    expect(exists('docs.md')).toBe(false)

    await revertToTurn(repo, 'chat-1', 4)
    expect((await capture()).tree).toBe(states[3])
    expect(exists('feature.ts')).toBe(false)
    expect(read('docs.md')).toBe('docs\n')
    expect(gitState()).toEqual(state)
  })
})

describe.skipIf(!process.env.FAROL_PERF)('snapshot time on a large repo', () => {
  it('captures a 50k-file checkout after a small change', async () => {
    const files = 50_000
    for (let d = 0; d < 500; d++) {
      const dir = path.join(repo, 'src', `d${d}`)
      fs.mkdirSync(dir, { recursive: true })
      for (let f = 0; f < files / 500; f++) fs.writeFileSync(path.join(dir, `f${f}.ts`), `export const v = ${d * 100 + f}\n`)
    }
    git('add', '.')
    git('commit', '-qm', 'big')
    for (let i = 0; i < 10; i++) write(`src/d${i}/f0.ts`, 'changed\n')
    write('src/new.ts', 'new\n')

    const cold = performance.now()
    await captureLimited(repo, CHECKPOINT_MAX_FILE_BYTES)
    const first = performance.now() - cold
    const warm = performance.now()
    await captureLimited(repo, CHECKPOINT_MAX_FILE_BYTES)
    const second = performance.now() - warm
    console.info(`[perf] ${files} files: first snapshot ${first.toFixed(0)} ms, next ${second.toFixed(0)} ms`)
    expect(second).toBeLessThan(10_000)
  }, 300_000)
})
