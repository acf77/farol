import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTaskEvent, AgentTaskRequest } from '../shared/types'

vi.mock('./jev', () => ({
  selectPipelines: vi.fn().mockResolvedValue(null),
  selectTools: vi.fn().mockResolvedValue(null)
}))
vi.mock('./backoff', () => ({ backoffDelayMs: () => 0, backoffWait: () => Promise.resolve() }))

import { AgentController, type AgentExecutor } from './agent-controller'

let repo: string
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
const exists = (name: string): boolean => fs.existsSync(path.join(repo, name))

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-turns-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-qm', 'init')
})

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

function request(): AgentTaskRequest {
  return {
    id: 'task-1',
    prompt: 'Turn one',
    provider: 'claude',
    mode: 'build',
    pipelines: [
      { id: 'validate', name: 'Validate', nodes: [{ id: 't', name: 'Tests', type: 'shell', cmd: 'npm test', after: [], x: 0, y: 0 }] }
    ],
    cwd: repo,
    checkout: repo,
    branch: 'main',
    maxAttempts: 1
  }
}

/** Each turn writes `turn-N.txt`; `hold` parks the next turn until released. */
function harness() {
  const events: AgentTaskEvent[] = []
  const prompts: string[] = []
  let turn = 0
  let hold: Promise<void> | undefined
  const execute: AgentExecutor = async (_req, prompt, output) => {
    prompts.push(prompt)
    turn += 1
    fs.writeFileSync(path.join(repo, `turn-${turn}.txt`), `${turn}\n`)
    if (hold) await hold
    output('Done\nFAROL_PIPELINES: []\n')
    return 0
  }
  const controller = new AgentController({ run: vi.fn() }, (event) => events.push(event), execute)
  return {
    controller,
    events,
    prompts,
    holdNext(): () => void {
      let release!: () => void
      hold = new Promise<void>((resolve) => (release = () => { hold = undefined; resolve() }))
      return release
    }
  }
}

const idle = (events: AgentTaskEvent[], count: number) =>
  events.filter((event) => event.kind === 'status' && event.status === 'completed').length >= count

describe('per-turn checkpoints in Chat', () => {
  it('checkpoint every turn, refuse a revert while the agent works, then revert and undo it', async () => {
    const { controller, events, prompts, holdNext } = harness()
    /** `runs` agent turns have ended and `checkpoints` are saved, a revert's safety checkpoint among them. */
    const settled = async (runs: number, checkpoints = runs) => {
      await vi.waitFor(() => expect(idle(events, runs)).toBe(true))
      await vi.waitFor(async () => {
        const list = await controller.turns('task-1')
        expect(list).toHaveLength(checkpoints)
        expect(list.every((entry) => entry.done)).toBe(true)
      })
    }

    controller.start(request())
    await settled(1)
    controller.message('task-1', 'Turn two')
    await settled(2)
    // A turn in flight cannot be reverted over.
    const release = holdNext()
    controller.message('task-1', 'Turn three')
    await vi.waitFor(() => expect(prompts).toHaveLength(3))
    expect(await controller.revertTurn('task-1', 2)).toEqual({
      ok: false,
      message: 'Stop the agent, or wait for it to finish, before reverting.'
    })
    expect(exists('turn-3.txt')).toBe(true)
    release()
    await settled(3)

    const turns = await controller.turns('task-1')
    expect(turns.map((entry) => [entry.turn, entry.prompt, entry.files.map((file) => file.path)])).toEqual([
      [1, 'Turn one', ['turn-1.txt']],
      [2, 'Turn two', ['turn-2.txt']],
      [3, 'Turn three', ['turn-3.txt']]
    ])
    const head = git('rev-parse', 'HEAD')

    expect(await controller.revertTurn('task-1', 2)).toMatchObject({ ok: true, fileCount: 2 })
    expect(exists('turn-1.txt')).toBe(true)
    expect(exists('turn-2.txt') || exists('turn-3.txt')).toBe(false)
    expect(git('rev-parse', 'HEAD')).toBe(head)
    const afterRevert = await controller.turns('task-1')
    expect(afterRevert[3]).toMatchObject({ turn: 4, kind: 'revert', done: true })

    // The agent hears about it, and the next message is a turn of its own.
    controller.message('task-1', 'Turn five')
    await settled(4, 5)
    expect(prompts[3]).toContain('the developer reverted the files to how they were before turn 2')

    // Undo: back to before the revert, with the turn-five file gone and turns two and three back.
    expect(await controller.revertTurn('task-1', 4)).toMatchObject({ ok: true })
    expect(exists('turn-2.txt') && exists('turn-3.txt')).toBe(true)
    expect(exists('turn-4.txt')).toBe(false)
    expect(git('branch', '--format=%(refname)').trim()).toBe('refs/heads/main')
  })

  it('drops a chat’s checkpoints when it is disposed', async () => {
    const { controller, events } = harness()
    controller.start(request())
    await vi.waitFor(() => expect(idle(events, 1)).toBe(true))
    await vi.waitFor(async () => expect(await controller.turns('task-1')).toHaveLength(1))
    controller.dispose('task-1')
    await vi.waitFor(() => expect(git('for-each-ref', 'refs/farol/checkpoints/')).toBe(''))
  })

  it('reads and reverts a chat after a restart, from the checkout the pane remembers', async () => {
    const first = harness()
    first.controller.start(request())
    await vi.waitFor(() => expect(idle(first.events, 1)).toBe(true))
    await vi.waitFor(async () => expect((await first.controller.turns('task-1')).every((entry) => entry.done)).toBe(true))

    const restarted = new AgentController({ run: vi.fn() }, () => undefined)
    expect(await restarted.turns('task-1')).toEqual([])
    expect(await restarted.turns('task-1', repo)).toHaveLength(1)
    expect(await restarted.revertTurn('task-1', 1, repo)).toMatchObject({ ok: true })
    expect(exists('turn-1.txt')).toBe(false)
  })
})
