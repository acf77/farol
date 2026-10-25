import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pipeline } from '../shared/types'

// Real git underneath; only the login shell is replaced, to record the commands it gets.
const { commands } = vi.hoisted(() => ({ commands: [] as string[] }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('./session', () => ({
  PtySession: class {
    whenReady = vi.fn().mockResolvedValue(true)
    exec = vi.fn(async (cmd: string) => {
      commands.push(cmd)
      return { code: 0 }
    })
    interrupt = vi.fn()
    kill = vi.fn()
  },
  defaultShell: vi.fn(() => '/bin/sh'),
  pipelineEnv: vi.fn(() => ({}))
}))

import { PipelineRunner } from './runner'

let repo: string
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
const write = (file: string, text: string): void => fs.writeFileSync(path.join(repo, file), text)
const read = (file: string): string => fs.readFileSync(path.join(repo, file), 'utf8')

/** A branch with a committed, a staged, an unstaged and a new file, while `main` moved on. */
beforeEach(() => {
  commands.length = 0
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-git-step-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  write('app.ts', 'a\n')
  write('lib.ts', 'b\n')
  write('.gitignore', '.env\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('checkout', '-qb', 'feature')
  write('app.ts', 'a committed\n')
  git('commit', '-qam', 'agent commit')
  git('checkout', '-q', 'main')
  write('other.ts', 'teammate\n')
  git('add', 'other.ts')
  git('commit', '-qm', 'teammate on main')
  git('checkout', '-q', 'feature')
  write('lib.ts', 'b staged\n')
  git('add', 'lib.ts')
  write('app.ts', 'a committed\na unstaged\n')
  write('new.ts', 'export const fresh = 1\n')
  write('.env', 'SECRET=ignored\n')
  write('id_rsa', 'PRIVATE KEY untracked\n')
})

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

const review = (base?: string): Pipeline => ({
  id: 'review',
  name: 'Review',
  nodes: [
    { id: 'd', name: 'Diff', type: 'git', op: 'diff', ...(base ? { base } : {}), as: 'diff', cmd: '', after: [], x: 0, y: 0 },
    { id: 's', name: 'Since last run', type: 'shell', cmd: 'printf %s ${diff_delta}', after: ['d'], x: 0, y: 0 }
  ]
})

describe('git diff steps', () => {
  it('diff everything the branch changed since it left base, and nothing that landed on base', async () => {
    const status = git('status', '--porcelain')
    const result = await new PipelineRunner(() => undefined).run(review('main'), repo, 'feature')

    expect(result.ok).toBe(true)
    const diff = read('.farol/git/review/diff.patch')
    expect(diff).toContain('+a committed')
    expect(diff).toContain('+a unstaged')
    expect(diff).toContain('+b staged')
    expect(diff).toContain('+export const fresh = 1')
    expect(diff).not.toContain('other.ts')
    // Ignored files stay out, and so do likely secrets that are merely untracked.
    expect(diff).not.toContain('SECRET')
    expect(diff).not.toContain('PRIVATE KEY')
    // The snapshot goes through its own index: the developer's staging is as it was.
    expect(git('status', '--porcelain')).toBe(status)
  })

  it('with no base, diff staged, unstaged and new files against HEAD', async () => {
    await new PipelineRunner(() => undefined).run(review(), repo, 'feature')

    const diff = read('.farol/git/review/diff.patch')
    expect(diff).toContain('+a unstaged')
    expect(diff).toContain('+b staged')
    expect(diff).toContain('+export const fresh = 1')
    expect(diff).not.toContain('+a committed')
  })

  it('hand the next run only what changed since this one as ${diff_delta}', async () => {
    const runner = new PipelineRunner(() => undefined)
    await runner.run(review('main'), repo, 'feature')
    expect(commands).toEqual(["printf %s ''"])

    write('app.ts', 'a committed\na fixed after review\n')
    const result = await runner.run(review('main'), repo, 'feature')

    expect(result.ok).toBe(true)
    const delta = read('.farol/git/review/diff.delta.patch')
    expect(delta).toContain('-a unstaged')
    expect(delta).toContain('+a fixed after review')
    expect(delta).not.toContain('lib.ts')
    expect(delta).not.toContain('new.ts')
    expect(delta).not.toContain('.farol')
    expect(commands[1]).toContain('+a fixed after review')
    // The full diff still covers the whole branch.
    expect(read('.farol/git/review/diff.patch')).toContain('+b staged')
  })

  it('fail the step with git\'s reason when base is not a known ref', async () => {
    const result = await new PipelineRunner(() => undefined).run(review('no-such-branch'), repo, 'feature')

    expect(result.ok).toBe(false)
    expect(result.failedNodeId).toBe('d')
  })
})
