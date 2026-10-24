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

  it('undoes a finished run, tells the agent on the next turn, and refuses while busy', async () => {
    let busyResult: Awaited<ReturnType<AgentController['undoDelegate']>> | undefined
    const child = vi.fn<AgentExecutor>(async () => {
      fs.writeFileSync(path.join(repo, 'b.txt'), 'x\n')
      fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n')
      return 0
    })
    const { controller, events, execute } = harness(child, async (c) => {
      const result = await c.delegate('task-1', { provider: 'codex', task: 'Write b.txt' })
      busyResult = await c.undoDelegate('task-1', 'task-1:d1')
      return [result]
    })
    controller.start(request())
    await vi.waitFor(() => expect(completed(events)).toBe(true))

    expect(busyResult).toEqual({ ok: false, message: 'Wait for the agent to finish, then undo.' })
    expect(events.some((e) => e.kind === 'delegate' && e.state === 'done' && e.undoable)).toBe(true)
    // The developer's own edit after the run survives the undo.
    fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine\n')

    expect(await controller.undoDelegate('task-1', 'task-1:d1')).toEqual({ ok: true })
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('one\n')
    expect(fs.readFileSync(path.join(repo, 'mine.txt'), 'utf8')).toBe('mine\n')
    expect(events.some((e) => e.kind === 'delegate' && e.undone === 'undo')).toBe(true)
    expect(await controller.undoDelegate('task-1', 'task-1:d1')).toEqual({ ok: false, message: 'Already undone.' })

    const calls = execute.mock.calls.length
    controller.start({ ...request(), prompt: 'Carry on' })
    await vi.waitFor(() => expect(execute.mock.calls.length).toBeGreaterThan(calls))
    expect(execute.mock.calls[calls][1]).toContain("the developer undid the Codex subagent's changes")
  })

  it('offers a restore when later edits overlap, and restores on request', async () => {
    const { controller, events } = harness(async () => {
      fs.writeFileSync(path.join(repo, 'a.txt'), 'subagent\n')
      return 0
    })
    controller.start(request())
    await vi.waitFor(() => expect(completed(events)).toBe(true))
    fs.writeFileSync(path.join(repo, 'a.txt'), 'developer\n')

    const outcome = await controller.undoDelegate('task-1', 'task-1:d1')
    expect(outcome).toMatchObject({ ok: false, restoreFiles: 1 })
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('developer\n')

    expect(await controller.undoDelegate('task-1', 'task-1:d1', true)).toEqual({ ok: true })
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('one\n')
    expect(events.some((e) => e.kind === 'delegate' && e.undone === 'restore')).toBe(true)
  })

  it('offers no undo for a run that changed nothing, and drops snapshots when the chat is cleared', async () => {
    const { controller, events } = harness(async () => {
      fs.writeFileSync(path.join(repo, 'b.txt'), 'x\n')
      return 0
    })
    controller.start(request())
    await vi.waitFor(() => expect(completed(events)).toBe(true))
    const refs = () => execFileSync('git', ['for-each-ref', 'refs/farol/'], { cwd: repo, encoding: 'utf8' })
    expect(refs()).toContain('refs/farol/delegate/task-1/task-1-d1/before')

    controller.dispose('task-1')
    await vi.waitFor(() => expect(refs()).toBe(''))

    const quiet = harness(async () => 0)
    quiet.controller.start({ ...request(), id: 'task-1' })
    await vi.waitFor(() => expect(completed(quiet.events)).toBe(true))
    const end = quiet.events.filter((e) => e.kind === 'delegate').pop()
    expect(end?.kind === 'delegate' && end.undoable).toBeFalsy()
  })

  describe('approvals', () => {
    /** A parent turn that asks for approvals while it runs, then finishes. */
    function asking(during: (c: AgentController) => Promise<unknown>) {
      const events: AgentTaskEvent[] = []
      const answers: unknown[] = []
      const execute = vi.fn<AgentExecutor>(async (_req, _prompt, output) => {
        answers.push(await during(controller))
        output('Done\nFAROL_PIPELINES: []\n')
        return 0
      })
      const controller: AgentController = new AgentController({ run: vi.fn() }, (e) => events.push(e), execute)
      return { controller, events, answers }
    }
    const pending = (events: AgentTaskEvent[]) =>
      events.filter((e): e is Extract<AgentTaskEvent, { kind: 'approval' }> => e.kind === 'approval' && !e.decision)

    it('asks in Chat and runs the tool once allowed; "for this chat" stops asking for that tool', async () => {
      const { controller, events, answers } = asking(async (c) => {
        const first = c.requestApproval('task-1', { toolName: 'Bash', input: { command: 'npm test' } })
        await vi.waitFor(() => expect(pending(events)).toHaveLength(1))
        const ask = pending(events)[0]
        expect(ask).toMatchObject({ provider: 'claude', toolName: 'Bash', detail: 'npm test' })
        expect(c.respondApproval('task-1', ask.requestId, 'chat')).toEqual({ ok: true })
        const again = await c.requestApproval('task-1', { toolName: 'Bash', input: { command: 'ls' } })
        return [await first, again]
      })
      controller.start(request())
      await vi.waitFor(() => expect(completed(events)).toBe(true))
      expect(answers[0]).toEqual([{ allow: true }, { allow: true }])
      expect(events.filter((e) => e.kind === 'approval')).toHaveLength(2)
      expect(events.some((e) => e.kind === 'approval' && e.decision === 'chat')).toBe(true)
    })

    it('passes a deny back to the agent as its reason', async () => {
      const { controller, events, answers } = asking(async (c) => {
        const answer = c.requestApproval('task-1', { toolName: 'Write', input: { file_path: 'a.txt' } })
        await vi.waitFor(() => expect(pending(events)).toHaveLength(1))
        c.respondApproval('task-1', pending(events)[0].requestId, 'deny')
        return answer
      })
      controller.start(request())
      await vi.waitFor(() => expect(completed(events)).toBe(true))
      expect(answers[0]).toMatchObject({ allow: false, message: expect.stringContaining('declined') })
    })

    it('lapses when the asking agent goes away or the turn is stopped', async () => {
      const gone = new AbortController()
      const { controller, events, answers } = asking(async (c) => {
        const first = c.requestApproval('task-1', { toolName: 'Bash', input: {} }, gone.signal)
        await vi.waitFor(() => expect(pending(events)).toHaveLength(1))
        gone.abort()
        const second = c.requestApproval('task-1', { toolName: 'Edit', input: {} })
        await vi.waitFor(() => expect(pending(events)).toHaveLength(2))
        c.cancel('task-1')
        return [await first, await second]
      })
      controller.start(request())
      await vi.waitFor(() => expect(answers).toHaveLength(1))
      expect(answers[0]).toEqual([
        expect.objectContaining({ allow: false }),
        expect.objectContaining({ allow: false })
      ])
      expect(events.filter((e) => e.kind === 'approval' && e.decision === 'expired')).toHaveLength(2)
      expect(controller.respondApproval('task-1', 'task-1:a1', 'once')).toEqual({
        ok: false,
        message: 'This request is no longer waiting.'
      })
    })

    it('refuses outright when no turn is running', async () => {
      const controller = new AgentController({ run: vi.fn() }, () => {}, vi.fn())
      expect(await controller.requestApproval('nope', { toolName: 'Bash', input: {} })).toMatchObject({ allow: false })
    })

    it('marks writes and shell calls that ran without asking', async () => {
      const events: AgentTaskEvent[] = []
      const execute = vi.fn<AgentExecutor>(async (_req, _prompt, output, tool) => {
        tool?.({ toolId: 'r', name: 'Read', state: 'done' })
        tool?.({ toolId: 'w', name: 'Write', detail: 'a.txt', state: 'done' })
        tool?.({ toolId: 'b', name: 'Bash', detail: 'ls', state: 'done' })
        output('Done\nFAROL_PIPELINES: []\n')
        return 0
      })
      const controller = new AgentController({ run: vi.fn() }, (e) => events.push(e), execute)
      controller.start(request())
      await vi.waitFor(() => expect(completed(events)).toBe(true))
      const auto = Object.fromEntries(
        events.flatMap((e) => (e.kind === 'tool' ? [[e.name, e.auto === true]] : []))
      )
      expect(auto).toEqual({ Read: false, Write: true, Bash: true })
    })
  })

  describe('Codex Ask first', () => {
    const managed = { mcp: () => ({ command: 'x', args: [] }), codexHook: () => 'hook' }
    const codexRequest = () => ({ ...request(), provider: 'codex' as const, autoApprove: false })

    function codexRun(during: (c: AgentController, tool: NonNullable<Parameters<AgentExecutor>[3]>) => Promise<void>) {
      const events: AgentTaskEvent[] = []
      const execute = vi.fn<AgentExecutor>(async (_req, _prompt, output, tool) => {
        await during(controller, tool!)
        output('Done\nFAROL_PIPELINES: []\n')
        return 0
      })
      const controller: AgentController = new AgentController(
        { run: vi.fn() },
        (e) => events.push(e),
        execute,
        undefined,
        undefined,
        undefined,
        managed
      )
      return { controller, events }
    }
    const stopped = (events: AgentTaskEvent[]) =>
      events.find((e) => e.kind === 'status' && e.status === 'needs-attention')

    it('lets through each write or shell call the developer approved, one for one', async () => {
      const { controller, events } = codexRun(async (c, tool) => {
        const answer = c.requestApproval('task-1', { toolName: 'Bash', input: { command: 'ls' } })
        await vi.waitFor(() => expect(events.some((e) => e.kind === 'approval' && !e.decision)).toBe(true))
        const ask = events.find((e) => e.kind === 'approval')
        if (ask?.kind === 'approval') c.respondApproval('task-1', ask.requestId, 'once')
        await answer
        tool({ toolId: 'i1', name: 'shell', detail: 'ls', state: 'running' })
        tool({ toolId: 'i1', name: 'shell', state: 'done' })
      })
      controller.start(codexRequest())
      await vi.waitFor(() => expect(completed(events)).toBe(true))
      expect(stopped(events)).toBeUndefined()
      expect(events.some((e) => e.kind === 'tool' && e.auto)).toBe(false)
    })

    it('stops the run when a write or shell call comes through unapproved', async () => {
      const { controller, events } = codexRun(async (_c, tool) => {
        tool({ toolId: 'i1', name: 'apply_patch', detail: 'a.txt', state: 'running' })
      })
      controller.start(codexRequest())
      await vi.waitFor(() => expect(stopped(events)).toBeDefined())
      const status = stopped(events)
      expect(status?.kind === 'status' && status.message).toContain('Codex ran apply_patch without asking')
    })

    it('does not gate a Codex chat that auto-approves', async () => {
      const { controller, events } = codexRun(async (_c, tool) => {
        tool({ toolId: 'i1', name: 'shell', detail: 'ls', state: 'done' })
      })
      controller.start({ ...codexRequest(), autoApprove: true })
      await vi.waitFor(() => expect(completed(events)).toBe(true))
      expect(stopped(events)).toBeUndefined()
      expect(events.some((e) => e.kind === 'tool' && e.auto)).toBe(true)
    })
  })
})
