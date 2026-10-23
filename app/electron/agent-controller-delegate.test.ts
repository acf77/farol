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

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-delegate-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo })
  git('init', '-q')
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
    prompt: 'Fix the widget',
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

type DelegateResult = Awaited<ReturnType<AgentController['delegate']>>

/**
 * The parent agent (Claude) calls `delegate` partway through its turn, as its
 * MCP tool would, and finishes once the subagent has. `child` plays the subagent.
 */
function harness(child: AgentExecutor, during?: (controller: AgentController) => Promise<DelegateResult[]>) {
  const events: AgentTaskEvent[] = []
  const results: DelegateResult[] = []
  const execute = vi.fn<AgentExecutor>(async (req, prompt, output, tool, session) => {
    if (req.provider !== 'claude') return child(req, prompt, output, tool, session)
    tool?.({ toolId: 'p1', name: 'mcp__farol-chat__delegate', state: 'running' })
    results.push(
      ...(during
        ? await during(controller)
        : [await controller.delegate('task-1', { provider: 'codex', model: 'gpt-5.6', task: 'Write b.txt', context: 'Use two lines' })])
    )
    output('Done\nFAROL_PIPELINES: []\n')
    return 0
  })
  // `execute` only runs after start(), by which time `controller` exists.
  const controller: AgentController = new AgentController({ run: vi.fn() }, (event) => events.push(event), execute)
  return { controller, events, results, execute }
}

const completed = (events: AgentTaskEvent[]) =>
  events.some((event) => event.kind === 'status' && (event.status === 'completed' || event.status === 'failed'))

describe('AgentController.delegate', () => {
  it('runs the subagent in the same checkout and returns its summary and changes', async () => {
    const child = vi.fn<AgentExecutor>(async (_req, _prompt, output, tool) => {
      tool?.({ toolId: 'w1', name: 'Write', detail: 'b.txt', state: 'running' })
      fs.writeFileSync(path.join(repo, 'b.txt'), 'x\ny\n')
      tool?.({ toolId: 'w1', name: 'Write', state: 'done' })
      output('Wrote b.txt with two lines.')
      return 0
    })
    const { controller, events, results, execute } = harness(child)

    controller.start(request())
    await vi.waitFor(() => expect(completed(events)).toBe(true))

    const [req, prompt] = child.mock.calls[0]
    expect(req).toMatchObject({ provider: 'codex', model: 'gpt-5.6', cwd: repo, mode: 'build' })
    expect(prompt).toContain('You are a subagent')
    expect(prompt).toContain('Write b.txt')
    expect(prompt).toContain('Use two lines')
    expect(prompt).toContain('Do not run Farol pipelines')
    expect(execute).toHaveBeenCalledTimes(2)

    expect(results[0]).toMatchObject({ ok: true, failed: false })
    const text = results[0].ok ? results[0].text : ''
    expect(text).toContain('Wrote b.txt with two lines.')
    expect(text).toContain('b.txt')

    const cards = events.filter((e) => e.kind === 'delegate')
    expect(cards.map((e) => e.kind === 'delegate' && e.state)).toEqual(['running', 'done'])
    const done = cards[1]
    expect(done.kind === 'delegate' && done.parentToolId).toBe('p1')
    expect(done.kind === 'delegate' && done.diffStat).toContain('b.txt')
    // The subagent's own activity is tagged for its card, and ids cannot collide with the parent's.
    const tools = events.filter((e) => e.kind === 'tool' && e.delegateId)
    expect(tools.map((e) => e.kind === 'tool' && e.toolId)).toEqual(['task-1:d1:w1', 'task-1:d1:w1'])
  })

  it('reports a subagent that fails, with nothing changed', async () => {
    const { controller, events, results } = harness(async (_r, _p, output) => {
      output('could not start')
      return 2
    })
    controller.start(request())
    await vi.waitFor(() => expect(completed(events)).toBe(true))

    expect(results[0]).toMatchObject({ ok: true, failed: true })
    const text = results[0].ok ? results[0].text : ''
    expect(text).toContain('exited with code 2')
    expect(text).toContain('It changed no files.')
    expect(events.some((e) => e.kind === 'delegate' && e.state === 'error')).toBe(true)
  })

  it('allows one subagent at a time and checks the provider', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { controller, events, results } = harness(
      async () => {
        await gate
        return 0
      },
      async (c) => {
        const first = c.delegate('task-1', { provider: 'codex', task: 'one' })
        const second = await c.delegate('task-1', { provider: 'codex', task: 'two' })
        const unknown = await c.delegate('task-1', { provider: 'nope', task: 'three' })
        release()
        return [await first, second, unknown]
      }
    )
    controller.start(request())
    await vi.waitFor(() => expect(completed(events)).toBe(true))

    expect(results[0]).toMatchObject({ ok: true })
    expect(results[1]).toEqual({ ok: false, message: 'A subagent is already running. Wait for it to finish.' })
    expect(results[2]).toEqual({ ok: false, message: 'Unknown provider: nope' })
  })

  it('refuses when no turn is running', async () => {
    const controller = new AgentController({ run: vi.fn() }, () => {}, vi.fn())
    expect(await controller.delegate('missing', { provider: 'codex', task: 'x' })).toEqual({
      ok: false,
      message: 'No Chat turn is running for this task.'
    })
  })

  it('reports a subagent stopped because the asking agent went away', async () => {
    const gone = new AbortController()
    const { controller, events, results } = harness(
      async () => {
        gone.abort()
        return 143
      },
      async (c) => [await c.delegate('task-1', { provider: 'codex', task: 'x' }, gone.signal)]
    )
    controller.start(request())
    await vi.waitFor(() => expect(completed(events)).toBe(true))
    expect(results[0]).toMatchObject({ ok: true, failed: true })
    expect(results[0].ok && results[0].text).toContain('Stopped before it finished.')
  })
})
