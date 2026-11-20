import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
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

let repo: string

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'farol-git-actions-')))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo })
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const name = "Widget"\n')
  git('add', '.')
  git('commit', '-qm', 'init')
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
function agent(turns: string[], change?: () => void) {
  let turn = 0
  return vi.fn<AgentExecutor>().mockImplementation(async (_request, _prompt, output) => {
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
  const run = vi.fn().mockResolvedValue(passed)
  const gitRun = vi.fn<GitActions['run']>(options.run ?? (async () => DONE))
  const git: GitActions = { enabled: async () => options.enabled ?? true, branch: async () => options.branch, run: gitRun }
  const controller = new AgentController({ run }, (event) => events.push(event), execute, undefined, undefined, undefined, undefined, undefined, git)
  controller.start(options.request ?? request())
  const completed = () =>
    vi.waitFor(() => expect(events.filter((e) => e.kind === 'status' && e.status === 'completed')).not.toHaveLength(0), { timeout: 10_000 })
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
    // The renderer's checkout is not handed on: the app finds the folder's project itself.
    const [cwd, action, scope] = gitRun.mock.calls[0]!
    expect(cwd).toBe(repo)
    // The commit is held to the working copy validation saw: a git tree of it, taken when the attempt ended.
    expect(scope.tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(action).toMatchObject({ action: 'commit', message: 'feat: rename widget' })
    expect(action.action === 'commit' && [...(action.files ?? [])].sort()).toEqual(['app.ts', 'new.ts'])
    expect(run.mock.invocationCallOrder[0]).toBeLessThan(gitRun.mock.invocationCallOrder[0]!)
    expect(events.some((e) => e.kind === 'pipeline' && !!e.git && e.status === 'passed')).toBe(true)
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

  it('keeps an in-flight action queue in its original repository and mode', async () => {
    execFileSync('git', ['branch', '-M', 'main'], { cwd: repo })
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'farol-other-repo-')))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: other })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const execute = agent([
      'FAROL_GIT: {"action":"push"}\nFAROL_GIT: {"action":"create_pr"}\nFAROL_PIPELINES: []',
      'FAROL_PIPELINES: []'
    ])
    let calls = 0
    const { gitRun, controller, events } = setup(execute, {
      branch: 'main',
      run: async () => { if (++calls === 1) await gate; return DONE }
    })
    try {
      await vi.waitFor(() => expect(gitRun).toHaveBeenCalledTimes(1), { timeout: 10_000 })
      controller.message('task-1', 'Read the other repository', undefined, undefined, undefined, 'plan', undefined, other, other)
      expect(execute.mock.calls[0][0]).toMatchObject({ cwd: repo, mode: 'build' })
      release()
      await vi.waitFor(() => expect(events.filter((event) => event.kind === 'status' && event.status === 'completed')).toHaveLength(2), { timeout: 10_000 })
      expect(gitRun.mock.calls.map((call) => [call[0], call[1].action, call[2].branch])).toEqual([
        [repo, 'push', 'main'], [repo, 'create_pr', 'main']
      ])
      expect(execute.mock.calls[1][0]).toMatchObject({ cwd: other, checkout: other, mode: 'plan' })
    } finally {
      release()
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('cannot lift an active Plan restriction with a queued Build request', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const execute = vi.fn<AgentExecutor>(async (_request, _prompt, output) => {
      if (++calls === 1) {
        await gate
        output('FAROL_GIT: {"action":"push"}\nFAROL_PIPELINES: []\n')
      } else output('FAROL_PIPELINES: []\n')
      return 0
    })
    const { gitRun, controller, events } = setup(execute, { request: request({ mode: 'plan' }) })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1), { timeout: 10_000 })
    controller.setProvider('task-1', 'claude', undefined, 'build')
    controller.message('task-1', 'Start the change', undefined, undefined, undefined, 'build')
    expect(execute.mock.calls[0][0].mode).toBe('plan')
    release()
    await vi.waitFor(() => expect(events.filter((event) => event.kind === 'status' && event.status === 'completed')).toHaveLength(2), { timeout: 10_000 })
    expect(gitRun).not.toHaveBeenCalled()
    expect(events.some((event) => event.kind === 'pipeline' && event.git?.detail.includes('Plan permits only Git read actions'))).toBe(true)
    expect(execute.mock.calls[1][0].mode).toBe('build')
  })

  it('does not commit when another chat worked in the same checkout during the turn', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const execute = vi.fn<AgentExecutor>().mockImplementation(async (req, _prompt, output) => {
      if (req.id === 'task-1') {
        await gate
        changeFiles()
      }
      output(`Done.\nFAROL_GIT: ${COMMIT}\nFAROL_PIPELINES: ["lint"]\n`)
      return 0
    })
    const { events, gitRun, controller } = setup(execute, { request: request({ id: 'task-1' }) })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1), { timeout: 10_000 })
    controller.start(request({ id: 'task-2' }))
    release()
    await vi.waitFor(() => expect(events.filter((e) => e.kind === 'status' && e.status === 'completed')).toHaveLength(2), {
      timeout: 10_000
    })

    // Neither chat can say which files are its own, so neither commit goes on.
    expect(gitRun).not.toHaveBeenCalled()
    expect(events.filter((e) => e.kind === 'pipeline' && !!e.git && e.status === 'failed')).toHaveLength(2)
  })

  it('hands a hook pipeline\'s failure back to the agent and commits after the repair', async () => {
    const blocked: GitActionResult = { ok: false, message: 'Commit failed', hookRun: { hooks: ['pre-commit'], output: 'lint: 2 errors' } }
    let calls = 0
    const execute = agent([`FAROL_GIT: ${COMMIT}\nFAROL_PIPELINES: ["lint"]`, `FAROL_GIT: ${COMMIT}\nFAROL_PIPELINES: []`], changeFiles)
    const { gitRun, completed } = setup(execute, { run: async () => (calls++ === 0 ? blocked : DONE) })
    await completed()

    expect(execute).toHaveBeenCalledTimes(2)
    const repair = vi.mocked(execute).mock.calls[1]![1]
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
    expect(events.some((e) => e.kind === 'pipeline' && !!e.git && e.status === 'failed')).toBe(true)

    controller.message('task-1', 'carry on')
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2), { timeout: 10_000 })
    expect(vi.mocked(execute).mock.calls[1]![1]).toContain('Note from Farol: Git commit refused: Git actions are turned off in Settings.')
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
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'status' && e.status === 'cancelled')).toBe(true), { timeout: 10_000 })

    // The chat is usable again, and nothing more happens to the stopped turn.
    controller.message('task-1', 'carry on')
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2), { timeout: 10_000 })
    await vi.waitFor(() => expect(events.filter((e) => e.kind === 'status' && e.status === 'completed')).toHaveLength(1), { timeout: 10_000 })
    expect(gitRun).toHaveBeenCalledTimes(1)
    expect(gitRun.mock.calls[0]![1]).toMatchObject({ action: 'commit' })
    // Stop reached the action through its scope, so one still waiting for its turn on the checkout would not begin.
    expect(gitRun.mock.calls[0]![2].signal?.aborted).toBe(true)
  })

  it('asks the agent to send a line it could not read again', async () => {
    const execute = agent(['FAROL_GIT: nope\nFAROL_PIPELINES: []', 'FAROL_GIT: {"action":"push"}\nFAROL_PIPELINES: []'])
    const { gitRun, completed } = setup(execute)
    await completed()

    expect(vi.mocked(execute).mock.calls[1]![1]).toContain('Farol could not read a FAROL_GIT: line.')
    expect(gitRun).toHaveBeenCalledTimes(1)
    expect(gitRun.mock.calls[0]![1]).toEqual({ action: 'push' })
  })

  it('keeps the Git rule when actions are off and refuses requests without another route', async () => {
    const on = agent(['FAROL_PIPELINES: []'])
    await setup(on).completed()
    expect(vi.mocked(on).mock.calls[0]![1]).toContain('FAROL_GIT:')

    const off = agent([`FAROL_GIT: ${COMMIT}\nFAROL_PIPELINES: []`])
    const { gitRun, completed } = setup(off, { enabled: false })
    await completed()
    expect(vi.mocked(off).mock.calls[0]![1]).toContain('Never run git or gh')
    expect(vi.mocked(off).mock.calls[0]![1]).toContain('Git actions are off')
    expect(gitRun).not.toHaveBeenCalled()
  })

  it('refuses a Git write request in Plan and keeps the Git rule', async () => {
    const execute = agent(['FAROL_GIT: {"action":"push"}\nFAROL_PIPELINES: []'])
    const { gitRun, events, completed } = setup(execute, { request: request({ mode: 'plan' }) })
    await completed()
    expect(vi.mocked(execute).mock.calls[0]![1]).toContain('Plan permits only Git read actions')
    expect(events.some((event) => event.kind === 'pipeline' && event.git?.detail.includes('Plan permits only Git read actions'))).toBe(true)
    expect(gitRun).not.toHaveBeenCalled()
  })

  for (const mode of ['build', 'plan'] as const) {
    it(`returns Git read results for the agent to use in ${mode}`, async () => {
      const execute = agent([
        'FAROL_GIT: {"action":"status"}\nFAROL_GIT: {"action":"diff"}\nFAROL_GIT: {"action":"log"}\nFAROL_GIT: {"action":"show","ref":"HEAD"}\nFAROL_PIPELINES: []',
        'FAROL_PIPELINES: []'
      ])
      const { gitRun, run, completed } = setup(execute, {
        request: request({ mode, maxAttempts: 1 }), run: async (_cwd, action) => ({ ok: true, message: `Read ${action.action}` })
      })
      await completed()
      expect(gitRun.mock.calls.map((call) => call[1].action)).toEqual(['status', 'diff', 'log', 'show'])
      expect(execute).toHaveBeenCalledTimes(2)
      const prompt = execute.mock.calls[1]![1]
      expect(prompt).toContain('Git status done: Read status')
      expect(prompt).toContain('Git show done: Read show')
      expect(prompt).toContain('Do not repeat completed actions')
      expect(run).not.toHaveBeenCalled()
    })
  }

})
