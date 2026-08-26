import { describe, expect, it, vi } from 'vitest'
import type { AgentTaskEvent, AgentTaskRequest, PipelineRunResult } from '../shared/types'
import { AgentController } from './agent-controller'

const request: AgentTaskRequest = {
  id: 'task-1',
  prompt: 'Fix the widget',
  provider: 'claude',
  pipelines: [
    {
      id: 'validate',
      name: 'Validate',
      nodes: [
        {
          id: 'test',
          name: 'Tests',
          type: 'shell',
          cmd: 'npm test',
          after: [],
          x: 0,
          y: 0
        }
      ]
    }
  ],
  cwd: '/tmp/project',
  branch: 'main',
  maxAttempts: 3
}

function result(ok: boolean): PipelineRunResult {
  return {
    runId: `run-${ok}`,
    pipelineId: 'validate',
    ok,
    failedNodeId: ok ? undefined : 'test',
    steps: [{ nodeId: 'test', ok, code: ok ? 0 : 1, output: ok ? '' : 'one test failed' }]
  }
}

function selecting(...ids: string[]) {
  return vi.fn().mockImplementation(
    async (
      _request: AgentTaskRequest,
      _prompt: string,
      output: (chunk: string) => void
    ) => {
      output(`Done\nBUILDFLOW_PIPELINES: ${JSON.stringify(ids)}\n`)
      return 0
    }
  )
}

describe('AgentController', () => {
  it('gives the agent every pipeline and runs all selected ids', async () => {
    const events: AgentTaskEvent[] = []
    const lint = {
      ...request.pipelines[0],
      id: 'lint',
      name: 'Lint',
      nodes: [{ ...request.pipelines[0].nodes[0], id: 'lint-step', cmd: 'npm run lint' }]
    }
    const run = vi.fn().mockResolvedValue(result(true))
    const execute = selecting('validate', 'lint')
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start({ ...request, pipelines: [...request.pipelines, lint] })
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )

    expect(execute.mock.calls[0][1]).toContain('Validate [id: validate]')
    expect(execute.mock.calls[0][1]).toContain('Lint [id: lint]')
    expect(execute.mock.calls[0][1]).toContain('npm run lint')
    expect(execute.mock.calls[0][1]).toContain('Do not call the BuildFlow MCP tools')
    expect(run.mock.calls.map((call) => call[0].id)).toEqual(['validate', 'lint'])
  })

  it('skips validation when the agent selects an empty pipeline list', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn().mockResolvedValue(result(true))
    const execute = selecting()
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start(request)
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )

    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][1]).toContain('If you made no code changes, select none')
    expect(execute.mock.calls[0][1]).toContain(`${'BUILDFLOW_PIPELINES:'} []`)
    expect(run).not.toHaveBeenCalled()
    expect(
      events.some(
        (event) =>
          event.kind === 'status' &&
          event.status === 'completed' &&
          event.message.includes('No validation needed')
      )
    ).toBe(true)
  })

  it('retries when the agent omits the pipeline selection marker', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn().mockResolvedValue(result(true))
    const execute = vi
      .fn()
      .mockImplementationOnce(async (_request, _prompt, output: (chunk: string) => void) => {
        output('Done without a marker\n')
        return 0
      })
      .mockImplementationOnce(
        async (
          _request: AgentTaskRequest,
          _prompt: string,
          output: (chunk: string) => void
        ) => {
          output('BUILDFLOW_PIPELINES: ["validate"]\n')
          return 0
        }
      )
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start(request)
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )

    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][1]).toContain('pipeline selection was invalid')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('repairs a failed validation and completes only after a pass', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn().mockResolvedValueOnce(result(false)).mockResolvedValueOnce(result(true))
    const execute = selecting('validate')
    const controller = new AgentController(
      { run },
      (event) => events.push(event),
      execute
    )

    expect(controller.start(request)).toEqual({ ok: true })
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )

    expect(execute).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][1]).toContain('one test failed')
    expect(execute.mock.calls[1][1]).toContain('BuildFlow pipeline activity for this chat:')
    expect(execute.mock.calls[1][1]).toMatch(
      /Validate \(validate\) started at .*; finished at .*; status FAILED; duration \d+ms; run id run-false\./
    )
    const statuses = events.flatMap((event) => (event.kind === 'status' ? [event.status] : []))
    expect(statuses).toEqual(['working', 'validating', 'repairing', 'validating', 'completed'])
    const pipelineEvents = events.flatMap((event) => (event.kind === 'pipeline' ? [event] : []))
    expect(pipelineEvents.map((event) => event.status)).toEqual([
      'running',
      'failed',
      'running',
      'passed'
    ])
    expect(pipelineEvents[0].startedAt).toBeTypeOf('number')
    expect(pipelineEvents[1].finishedAt).toBeGreaterThanOrEqual(pipelineEvents[0].startedAt)
  })

  it('does not validate or complete when the agent process fails', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn()
    const controller = new AgentController(
      { run },
      (event) => events.push(event),
      vi.fn().mockResolvedValue(127)
    )

    controller.start(request)
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'needs-attention')).toBe(
        true
      )
    )

    expect(run).not.toHaveBeenCalled()
    expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(false)
  })

  it('stops without validation when the agent reports a blocker', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn()
    const execute = vi.fn().mockImplementation(
      async (
        _request: AgentTaskRequest,
        _prompt: string,
        output: (chunk: string) => void
      ) => {
        output('I cannot continue.\nBUILDFLOW_BLOCKED: repository access was denied\n')
        return 0
      }
    )
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start(request)
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.kind === 'status' &&
            event.status === 'needs-attention' &&
            event.message.includes('repository access was denied')
        )
      ).toBe(true)
    )

    expect(run).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('stops and reports an unexpected executor error', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn()
    const controller = new AgentController(
      { run },
      (event) => events.push(event),
      vi.fn().mockRejectedValue(new Error('provider connection failed'))
    )

    controller.start(request)
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.kind === 'status' &&
            event.status === 'failed' &&
            event.message.includes('provider connection failed')
        )
      ).toBe(true)
    )

    expect(run).not.toHaveBeenCalled()
  })

  it('stops and reports an unexpected validation error', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn().mockRejectedValue(new Error('validation could not start'))
    const controller = new AgentController(
      { run },
      (event) => events.push(event),
      selecting('validate')
    )

    controller.start(request)
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.kind === 'status' &&
            event.status === 'failed' &&
            event.message.includes('validation could not start')
        )
      ).toBe(true)
    )

    expect(run).toHaveBeenCalledTimes(1)
  })

  it('stops after the retry budget without reporting completion', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn().mockResolvedValue(result(false))
    const controller = new AgentController(
      { run },
      (event) => events.push(event),
      selecting('validate')
    )

    controller.start({ ...request, maxAttempts: 2 })
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.kind === 'status' &&
            event.status === 'needs-attention' &&
            event.message.includes('2 attempts')
        )
      ).toBe(true)
    )

    expect(run).toHaveBeenCalledTimes(2)
    expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(false)
  })

  it('resumes the agent when the user messages after Stop', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn().mockResolvedValue(result(true))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate
        return 0
      })
      .mockImplementationOnce(
        async (
          _request: AgentTaskRequest,
          prompt: string,
          output: (chunk: string) => void
        ) => {
          expect(prompt).toContain('try again with a narrower fix')
          output('BUILDFLOW_PIPELINES: []\n')
          return 0
        }
      )
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start(request)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))

    controller.cancel(request.id)
    expect(
      events.some((event) => event.kind === 'status' && event.status === 'cancelled')
    ).toBe(true)

    expect(controller.message(request.id, 'try again with a narrower fix')).toEqual({ ok: true })
    release()

    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.kind === 'status' &&
            event.status === 'completed' &&
            event.message.includes('No validation needed')
        )
      ).toBe(true)
    )

    expect(execute).toHaveBeenCalledTimes(2)
    expect(run).not.toHaveBeenCalled()
  })

  it('resumes after Stop once the cancelled cycle has fully settled', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate
        return 0
      })
      .mockImplementationOnce(async (_request, _prompt, output: (chunk: string) => void) => {
        output('BUILDFLOW_PIPELINES: []\n')
        return 0
      })
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start(request)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    controller.cancel(request.id)
    release()
    await vi.waitFor(() =>
      expect(events.some((e) => e.kind === 'status' && e.status === 'cancelled')).toBe(true)
    )
    // Let the cancelled cycle settle (running → false) before the follow-up.
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    await Promise.resolve()

    expect(controller.message(request.id, 'continue please')).toEqual({ ok: true })
    await vi.waitFor(() =>
      expect(events.some((e) => e.kind === 'status' && e.status === 'completed')).toBe(true)
    )
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][1]).toContain('continue please')
  })
})
