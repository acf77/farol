import fs from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTaskEvent, AgentTaskRequest } from '../shared/types'

vi.mock('./jev', () => ({
  selectPipelines: vi.fn().mockResolvedValue(null),
  selectTools: vi.fn().mockResolvedValue(null)
}))
vi.mock('./backoff', () => ({ backoffDelayMs: () => 0, backoffWait: () => Promise.resolve() }))

import { AgentController, type AgentExecutor } from './agent-controller'
import { makeTempGitRepo } from './agent-controller-test-helpers'
import type { ProcRegistry } from './proc-sessions'

let repo: string

beforeEach(() => {
  repo = makeTempGitRepo('farol-procs-')
})

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

const request: () => AgentTaskRequest = () => ({
  id: 'task-1',
  prompt: 'Say hi',
  provider: 'claude',
  mode: 'build',
  pipelines: [],
  cwd: repo,
  checkout: repo,
  branch: 'main',
  maxAttempts: 1
})

interface Internals {
  tasks: Map<string, object>
  setProcess(task: object, child: boolean, proc: { pid?: number } | null): void
  releaseProcSessions(task: object): void
}

async function controllerWithProcs(): Promise<{ procs: ProcRegistry; internals: Internals; task: object }> {
  const procs = { register: vi.fn(), finish: vi.fn() } as unknown as ProcRegistry
  const events: AgentTaskEvent[] = []
  const execute: AgentExecutor = async (_request, _prompt, output) => {
    output('Hi.\nFAROL_PIPELINES: []\n')
    return 0
  }
  const controller = new AgentController({ run: vi.fn(() => Promise.resolve({ ok: true, runId: 'r', steps: [] })) }, (event) => events.push(event), execute, undefined, undefined, undefined, undefined, procs)
  controller.start(request())
  await vi.waitFor(() => expect(events.some((e) => e.kind === 'status' && e.status === 'completed')).toBe(true))
  const internals = controller as unknown as Internals
  return { procs, internals, task: internals.tasks.get('task-1')! }
}

describe('agent runs report their process to the registry', () => {
  it('registers a run when its process starts and finishes only when the turn releases it', async () => {
    const { procs, internals, task } = await controllerWithProcs()
    internals.setProcess(task, false, { pid: 4242 })
    expect(procs.register).toHaveBeenCalledWith('task-1:4242', repo, 4242)
    expect(procs.finish).not.toHaveBeenCalled()
    internals.setProcess(task, false, null)
    expect(procs.finish).not.toHaveBeenCalled()
    internals.releaseProcSessions(task)
    expect(procs.finish).toHaveBeenCalledWith('task-1:4242')
  })

  it('tracks a subagent apart from the agent', async () => {
    const { procs, internals, task } = await controllerWithProcs()
    internals.setProcess(task, false, { pid: 10 })
    internals.setProcess(task, true, { pid: 11 })
    internals.setProcess(task, true, null)
    expect(procs.finish).not.toHaveBeenCalled()
    internals.releaseProcSessions(task)
    expect(procs.finish).toHaveBeenCalledTimes(2)
    expect(procs.finish).toHaveBeenCalledWith('task-1:10')
    expect(procs.finish).toHaveBeenCalledWith('task-1:11')
  })

  it('ignores a spawn that failed and has no pid', async () => {
    const { procs, internals, task } = await controllerWithProcs()
    internals.setProcess(task, false, {})
    internals.setProcess(task, false, null)
    expect(procs.register).not.toHaveBeenCalled()
    expect(procs.finish).not.toHaveBeenCalled()
  })
})