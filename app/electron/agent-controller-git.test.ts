import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitActionResult } from '../shared/git-action'
import type { AgentTaskEvent, AgentTaskRequest, PipelineRunResult } from '../shared/types'

vi.mock('./jev', () => ({
  selectPipelines: vi.fn().mockResolvedValue(null),
  selectTools: vi.fn().mockResolvedValue(null)
}))
vi.mock('./backoff', () => ({ backoffDelayMs: () => 0, backoffWait: () => Promise.resolve() }))

import { AgentController, type AgentExecutor, type GitActions } from './agent-controller'
import { makeTempGitRepo } from './agent-controller-test-helpers'

let repo: string

beforeEach(() => {
  repo = makeTempGitRepo('farol-git-actions-')
})

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

const lint = {
  id: 'lint',
  name: 'Lint',
  mandatory: true,
  nodes: [{ id: 'lint-step', name: 'Lint', type: 'shell' as const, cmd: 'npm run lint', after: [], x: 0, y: 0 }]
}

const passed: PipelineRunResult = {
  runId: 'r',
  pipelineId: 'lint',
  ok: true,
  steps: [{ nodeId: 'lint-step', ok: true, code: 0, output: '' }]
}

const COMMIT = '{"action":"commit","message":"feat: rename widget"}'
const DONE: GitActionResult = { ok: true, message: 'Done' }

function request(overrides: Partial<AgentTaskRequest> = {}): AgentTaskRequest {
  return {
    id: 'task-1',
    prompt: 'Rename the widget',
    provider: 'claude',
    mode: 'build',
    pipelines: [lint],
    cwd: repo,
    checkout: repo,
    branch: 'main',
    maxAttempts: 3,
    ...overrides
  }
}

/** An agent that says `turns` in order (the last one again, if asked more), after running `change` in its first. */
function agent(turns: string[], change?: () => void): AgentExecutor {
  let turn = 0
  return vi.fn(async (_request, _prompt, output) => {
    if (turn === 0) change?.()
    output(`Done.\n${turns[Math.min(turn, turns.length - 1)]}\n`)
    turn += 1
    return 0
  })
}

interface Options {
  /** What Farol answers to a Git action; it succeeds by default. */
  run?: GitActions['run']
  enabled?: boolean
  /** The branch the checkout is on when the turn's actions begin; none by default. */
  branch?: string
  request?: AgentTaskRequest
}

function setup(execute: AgentExecutor, options: Options = {}) {
  const events: AgentTaskEvent[] = []
  const run = vi.fn(() => Promise.resolve(passed))
  const gitRun = vi.fn(options.run ?? (async () => DONE))
  const git: GitActions = { enabled: async () => options.enabled ?? true, branch: async () => options.branch, run: gitRun }
  const controller = new AgentController({ run }, (event) => events.push(event), execute, undefined, undefined, undefined, undefined, undefined, git)
  controller.start(options.request ?? request())
  const completed = () => vi.waitFor(() => expect(events.filter((e) => e.kind === 'status' && e.status === 'completed')).not.toHaveLength(0))
  return { events, run, gitRun, controller, completed }
}

const changeFiles = () => {
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const name = "Gadget"\n')
  fs.writeFileSync(path.join(repo, 'new.ts'), 'export const x = 1\n')
}

describe('Git actions a managed Chat asks for', () => {
  it('commits exactly the files the turn changed, once validation has passed', async () => {
    const { run, gitRun, events, completed } = setup(
      agent([`FAROL_GIT: {"action":"commit","message":"feat: rename widget","files":["secret.txt"]}\nFAROL_PIPELINES: ["lint"]`], changeFiles)
    )
    await completed()

    expect(gitRun).toHaveBeenCalledTimes(1)
    const [cwd, action, scope] = gitRun.mock.calls[0]!
    expect(cwd).toBe(repo)
    expect(scope.tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(action).toMatchObject({ action: 'commit', message: 'feat: rename widget' })
    expect(action.action === 'commit' && [...(action.files ?? [])].sort()).toEqual(['app.ts', 'new.ts'])
    expect(run.mock.invocationCallOrder[0]).toBeLessThan(gitRun.mock.invocationCallOrder[0]!)
    expect(events.some((e) => e.kind === 'tool' && e.name === 'git' && e.state === 'done')).toBe(true)
  })

  it('stops at the first action that fails, so a failed commit is not pushed', async () => {
    const { gitRun, completed } = setup(agent([`FAROL_GIT: ${COMMIT}\nFAROL_GIT: {"action":"push"}\nFAROL_PIPELINES: []`]), {
      run: async () => ({ ok: false, message: 'Working tree is clean' })
    })
    await completed()
    expect(gitRun).toHaveBeenCalledTimes(1)
    expect(gitRun.mock.calls[0]![1]).toMatchObject({ action: 'commit' })
  })

  it('holds every action of a turn to the branch the checkout was on when they began, and to the turn\'s stop signal', async () => {
    const { gitRun, completed } = setup(agent([`FAROL_GIT: ${COMMIT}\nFAROL_GIT: {"action":"push"}\nFAROL_PIPELINES: []`]), {
      branch: 'feat/x'
    })
    await completed()

    expect(gitRun).toHaveBeenCalledTimes(2)
    const [commitScope, pushScope] = gitRun.mock.calls.map((call) => call[2])
    expect(commitScope).toEqual({ branch: 'feat/x', signal: expect.any(AbortSignal) })
    expect(pushScope).toBe(commitScope)
    expect(commitScope.signal?.aborted).toBe(false)
  })

  it('does not commit when another chat worked in the same checkout during the turn', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const execute = vi.fn(async (req, _prompt, output) => {
      if (req.id === 'task-1') {
        await gate
        changeFiles()
      }
      output(`Done.\nFAROL_GIT: ${COMMIT}\nFAROL_PIPELINES: ["lint"]\n`)
      return 0
    })
    const { events, gitRun, controller } = setup(execute, { request: request({ id: 'task-1' }) })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    controller.start(request({ id: 'task-2' }))
    release()
    await vi.waitFor(() => expect(events.filter((e) => e.kind === 'status' && e.status === 'completed')).toHaveLength(2))

    expect(gitRun).not.toHaveBeenCalled()
    expect(events.filter((e) => e.kind === 'tool' && e.name === 'git' && e.state === 'error')).toHaveLength(2)
  })

  it('hands a hook pipeline\'s failure back to the agent and commits after the repair', async () => {
    const blocked: GitActionResult = { ok: false, message: 'Commit failed', hookRun: { hooks: ['pre-commit'], output: 'lint: 2 errors' } }
    let calls = 0
    const execute = agent([`FAROL_GIT: ${COMMIT}\nFAROL_PIPELINES: ["lint"]`, `FAROL_GIT: ${COMMIT}\nFAROL_PIPELINES: []`], changeFiles)
    const { gitRun, completed } = setup(execute, { run: async () => (calls++ === 0 ? blocked : DONE) })
    await completed()

    expect(execute).toHaveBeenCalledTimes(2)
    const repair = execute.mock.calls[1]![1]
    expect(repair).toContain('Blocked by pre-commit')
    expect(repair).toContain('lint: 2 errors')
    expect(gitRun).toHaveBeenCalledTimes(2)
  })

  it('shows a refusal in Chat without a retry, and tells the agent on its next turn', async () => {
    const refused: GitActionResult = { ok: false, refused: true, message: 'Git actions are turned off in Settings.' }
    const execute = agent([`FAROL_GIT: ${COMMIT}\nFAROL_PIPELINES: []`, 'FAROL_PIPELINES: []'])
    const { events, controller, completed } = setup(execute, { run: async () => refused })
    await completed()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(events.some((e) => e.kind === 'tool' && e.name === 'git' && e.state === 'error')).toBe(true)

    controller.message('task-1', 'carry on')
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    expect(execute.mock.calls[1]![1]).toContain('Note from Farol: Git commit refused: Git actions are turned off in Settings.')
  })

  it('lets the action in flight finish when the task is stopped, but runs none that were queued behind it', async () => {
    const execute = agent([`FAROL_GIT: ${COMMIT}\nFAROL_GIT: {"action":"push"}\nFAROL_PIPELINES: ["lint"]`, 'FAROL_PIPELINES: []'], changeFiles)
    const stop = { now: () => {} }
    const { events, gitRun, controller } = setup(execute, {
      run: async () => {
        stop.now()
        return DONE
      }
    })
    stop.now = () => controller.cancel('task-1')
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'status' && e.status === 'cancelled')).toBe(true))

    controller.message('task-1', 'carry on')
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(events.filter((e) => e.kind === 'status' && e.status === 'completed')).toHaveLength(1))
    expect(gitRun).toHaveBeenCalledTimes(1)
    expect(gitRun.mock.calls[0]![1]).toMatchObject({ action: 'commit' })
    expect(gitRun.mock.calls[0]![2].signal?.aborted).toBe(true)
  })

  it('asks the agent to send a line it could not read again', async () => {
    const execute = agent(['FAROL_GIT: nope\nFAROL_PIPELINES: []', 'FAROL_GIT: {"action":"push"}\nFAROL_PIPELINES: []'])
    const { gitRun, completed } = setup(execute)
    await completed()

    expect(execute.mock.calls[1]![1]).toContain('Farol could not read a FAROL_GIT: line.')
    expect(gitRun).toHaveBeenCalledTimes(1)
    expect(gitRun.mock.calls[0]![1]).toEqual({ action: 'push' })
  })

  it('tells the agent about Git actions, and acts on them, only while they are switched on', async () => {
    const on = agent(['FAROL_PIPELINES: []'])
    await setup(on).completed()
    expect(on.mock.calls[0]![1]).toContain('FAROL_GIT:')

    const off = agent([`FAROL_GIT: ${COMMIT}\nFAROL_PIPELINES: []`])
    const { gitRun, completed } = setup(off, { enabled: false })
    await completed()
    expect(off.mock.calls[0]![1]).not.toContain('FAROL_GIT:')
    expect(gitRun).not.toHaveBeenCalled()
  })

  it('ignores a Git request in Plan mode', async () => {
    const execute = agent(['FAROL_GIT: {"action":"push"}\nFAROL_PIPELINES: []'])
    const { gitRun, completed } = setup(execute, { request: request({ mode: 'plan' }) })
    await completed()
    expect(execute.mock.calls[0]![1]).not.toContain('FAROL_GIT:')
    expect(gitRun).not.toHaveBeenCalled()
  })
})