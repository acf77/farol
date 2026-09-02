import { describe, expect, it, vi } from 'vitest'
import type { AgentTaskEvent, AgentTaskRequest, PipelineRunResult } from '../shared/types'
import { failureReport } from '../shared/failure'
import { AgentController, type AgentExecutor } from './agent-controller'

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
      output(`Done\nFAROL_PIPELINES: ${JSON.stringify(ids)}\n`)
      return 0
    }
  )
}

const lintMandatory = {
  ...request.pipelines[0],
  id: 'lint',
  name: 'Lint',
  mandatory: true,
  nodes: [{ ...request.pipelines[0].nodes[0], id: 'lint-step', cmd: 'npm run lint' }]
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
    expect(execute.mock.calls[0][1]).toContain('Do not call the Farol MCP tools')
    expect(execute.mock.calls[0][1]).toContain('Never run the catalog\'s shell commands yourself')
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
    expect(execute.mock.calls[0][1]).toContain(`${'FAROL_PIPELINES:'} []`)
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
          output('FAROL_PIPELINES: ["validate"]\n')
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
    expect(execute.mock.calls[1][1]).toContain('Do not re-run the failing shell commands yourself')
    expect(execute.mock.calls[1][1]).toContain('Farol pipeline activity for this chat:')
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
        output('I cannot continue.\nFAROL_BLOCKED: repository access was denied\n')
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
          output('FAROL_PIPELINES: []\n')
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
        output('FAROL_PIPELINES: []\n')
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

  it('resumes when the user messages after a completed validation run', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn().mockResolvedValue(result(true))
    const execute = vi
      .fn()
      .mockImplementationOnce(
        async (_request: AgentTaskRequest, _prompt: string, output: (chunk: string) => void) => {
          output('Done\nFAROL_PIPELINES: ["validate"]\n')
          return 0
        }
      )
      .mockImplementationOnce(
        async (_request: AgentTaskRequest, prompt: string, output: (chunk: string) => void) => {
          expect(prompt).toContain('Follow-up: tighten the error message')
          output('Updated\nFAROL_PIPELINES: []\n')
          return 0
        }
      )
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start(request)
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )

    expect(controller.message(request.id, 'tighten the error message')).toEqual({ ok: true })
    await vi.waitFor(() =>
      expect(
        events.filter((event) => event.kind === 'status' && event.status === 'completed').length
      ).toBe(2)
    )

    expect(execute).toHaveBeenCalledTimes(2)
    expect(events.some((event) => event.kind === 'user' && event.text === 'tighten the error message')).toBe(
      true
    )
  })

  it('re-hydrates a finished task when start is called again with the same id', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn().mockResolvedValue(result(true))
    const execute = selecting()
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start(request)
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )

    expect(controller.start({ ...request, prompt: 'one more tweak' })).toEqual({ ok: true })
    await vi.waitFor(() =>
      expect(events.filter((event) => event.kind === 'user' && event.text === 'one more tweak').length).toBe(1)
    )
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('switches provider when the same task continues after a usage limit', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn()
    const execute = vi
      .fn()
      .mockImplementationOnce(
        async (req: AgentTaskRequest, _prompt: string, output: (chunk: string) => void) => {
          expect(req.provider).toBe('claude')
          output('Error: rate limit exceeded — try again later\n')
          return 1
        }
      )
      .mockImplementationOnce(
        async (req: AgentTaskRequest, prompt: string, output: (chunk: string) => void) => {
          expect(req.provider).toBe('cursor')
          expect(prompt).toContain('continue with another agent')
          output('FAROL_PIPELINES: []\n')
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
            event.message.toLowerCase().includes('rate limit')
        )
      ).toBe(true)
    )

    expect(
      controller.start({ ...request, provider: 'cursor', prompt: 'continue with another agent' })
    ).toEqual({ ok: true })
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(
        true
      )
    )

    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][0].provider).toBe('cursor')
  })

  it('treats a session limit as a provider failure so a switch can continue', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn()
    const execute = vi
      .fn()
      .mockImplementationOnce(async (_req, _prompt, output: (chunk: string) => void) => {
        output("You've hit your session limit · resets 2pm\n")
        return 1
      })
      .mockImplementationOnce(async (req: AgentTaskRequest, _prompt, output: (chunk: string) => void) => {
        expect(req.provider).toBe('cursor')
        output('FAROL_PIPELINES: []\n')
        return 0
      })
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start(request)
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.kind === 'status' &&
            event.status === 'needs-attention' &&
            event.message.toLowerCase().includes('session limit')
        )
      ).toBe(true)
    )

    expect(
      controller.start({ ...request, provider: 'cursor', prompt: 'continue on cursor' })
    ).toEqual({ ok: true })
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(
        true
      )
    )
    expect(execute.mock.calls[1][0].provider).toBe('cursor')
  })

  it('applies a provider override on message follow-ups', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn()
    const execute = vi
      .fn()
      .mockImplementationOnce(async (_req, _prompt, output: (chunk: string) => void) => {
        output('Error: usage limit reached\n')
        return 1
      })
      .mockImplementationOnce(async (req: AgentTaskRequest, _prompt, output: (chunk: string) => void) => {
        expect(req.provider).toBe('codex')
        output('FAROL_PIPELINES: []\n')
        return 0
      })
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start(request)
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'needs-attention')).toBe(
        true
      )
    )

    expect(controller.message(request.id, 'keep going', 'codex')).toEqual({ ok: true })
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )
    expect(execute.mock.calls[1][0].provider).toBe('codex')
  })

  it('refreshes validation pipeline AI providers on message follow-ups', async () => {
    const events: AgentTaskEvent[] = []
    const review = {
      id: 'full',
      name: 'Full Check',
      nodes: [
        {
          id: 'n3',
          name: 'AI Review',
          type: 'ai' as const,
          ai: 'claude' as const,
          cmd: 'Review lint/type output and the diff; flag risks',
          after: [] as string[],
          x: 0,
          y: 0
        }
      ]
    }
    const run = vi.fn().mockImplementation(async (pipeline: AgentTaskRequest['pipelines'][number]) => {
      expect(pipeline.nodes[0]?.ai).toBe('cursor')
      return result(true)
    })
    const execute = vi
      .fn()
      .mockImplementationOnce(async (_req, _prompt, output: (chunk: string) => void) => {
        output("You've hit your session limit · resets 8:20pm\n")
        return 1
      })
      .mockImplementationOnce(async (req: AgentTaskRequest, prompt: string, output: (chunk: string) => void) => {
        expect(prompt).toContain('ai/cursor')
        expect(req.pipelines[0]?.nodes[0]?.ai).toBe('cursor')
        output('FAROL_PIPELINES: ["full"]\n')
        return 0
      })
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start({ ...request, pipelines: [review] })
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'needs-attention')).toBe(
        true
      )
    )

    expect(
      controller.message(request.id, 'use cursor for this check', 'cursor', [
        {
          ...review,
          nodes: [{ ...review.nodes[0], ai: 'cursor' }]
        }
      ])
    ).toEqual({ ok: true })
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0].nodes[0].ai).toBe('cursor')
  })

  it('continues a queued provider switch after a usage limit mid-run', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn()
    let releaseLimit: (() => void) | undefined
    const execute = vi
      .fn()
      .mockImplementationOnce(
        async (req: AgentTaskRequest, _prompt: string, output: (chunk: string) => void) => {
          expect(req.provider).toBe('claude')
          await new Promise<void>((resolve) => {
            releaseLimit = resolve
          })
          output('Error: usage limit reached\n')
          return 1
        }
      )
      .mockImplementationOnce(async (req: AgentTaskRequest, prompt: string, output: (chunk: string) => void) => {
        expect(req.provider).toBe('cursor')
        expect(prompt).toContain('resume on cursor')
        output('FAROL_PIPELINES: []\n')
        return 0
      })
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start(request)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    expect(controller.message(request.id, 'resume on cursor', 'cursor')).toEqual({ ok: true })
    releaseLimit?.()

    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][0].provider).toBe('cursor')
  })

  it('setProvider updates the in-memory task before the next cycle', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn()
    const execute = vi
      .fn()
      .mockImplementationOnce(async (_req, _prompt, output: (chunk: string) => void) => {
        output('Error: rate limit reached\n')
        return 1
      })
      .mockImplementationOnce(async (req: AgentTaskRequest, _prompt, output: (chunk: string) => void) => {
        expect(req.provider).toBe('cursor')
        output('FAROL_PIPELINES: []\n')
        return 0
      })
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start(request)
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'needs-attention')).toBe(
        true
      )
    )

    expect(controller.setProvider(request.id, 'cursor')).toEqual({ ok: true })
    expect(controller.message(request.id, 'continue on cursor', 'cursor')).toEqual({ ok: true })
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )
    expect(execute.mock.calls[1][0].provider).toBe('cursor')
  })

  it('dispose drops a finished task so cleared chats release memory', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn()
    const execute = selecting()
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start(request)
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )

    controller.dispose(request.id)
    expect(controller.message(request.id, 'hello')).toEqual({
      ok: false,
      message: 'This agent task is no longer available.'
    })
  })

  it('accepts FAROL_PIPELINES ids from a manual UI failure report handoff', async () => {
    // Manual Run uses pipeline:; autoFix hands the report into managed Chat,
    // whose catalog only lists managed-pipeline: ids.
    const uiSlot = 'repo-abc:pipeline:lint'
    const managedId = 'repo-abc:managed-pipeline:lint'
    const report = failureReport({
      pipeline: 'Lint & Typecheck',
      pipelineId: uiSlot,
      step: 'TypeScript',
      branch: 'main',
      cwd: '/tmp/project',
      cmd: 'npx tsc --noEmit',
      code: 1,
      output: 'error TS2322'
    })
    const marker = report.match(/FAROL_PIPELINES: (\[[^\]]+\])/)
    expect(marker).toBeTruthy()
    const ids = JSON.parse(marker![1]) as string[]
    expect(ids).toEqual([managedId])

    const events: AgentTaskEvent[] = []
    const lint = {
      id: managedId,
      name: 'Lint & Typecheck',
      nodes: [
        {
          id: 'tsc',
          name: 'TypeScript',
          type: 'shell' as const,
          cmd: 'npx tsc --noEmit',
          after: [] as string[],
          x: 0,
          y: 0
        }
      ]
    }
    const run = vi.fn().mockResolvedValue({
      runId: 'run-ok',
      pipelineId: managedId,
      ok: true,
      steps: [{ nodeId: 'tsc', ok: true, code: 0, output: '' }]
    })
    const execute = selecting(...ids)
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start({ ...request, pipelines: [lint] })
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(
        true
      )
    )

    expect(run.mock.calls.map((call) => call[0].id)).toEqual([managedId])
    expect(
      events.some(
        (event) =>
          event.kind === 'status' &&
          event.status === 'failed' &&
          typeof event.message === 'string' &&
          event.message.includes('Unknown pipeline')
      )
    ).toBe(false)
  })

  it('rejects empty FAROL_PIPELINES when the agent shelled a catalog command', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn().mockResolvedValue(result(true))
    const execute = vi
      .fn()
      .mockImplementationOnce(
        async (
          _request: AgentTaskRequest,
          _prompt: string,
          output: (chunk: string) => void,
          onTool?: (event: {
            toolId: string
            name: string
            detail?: string
            state: 'running' | 'done' | 'error'
          }) => void
        ) => {
          onTool?.({
            toolId: 'shell-1',
            name: 'shell',
            detail: 'npm test',
            state: 'running'
          })
          onTool?.({
            toolId: 'shell-1',
            name: 'shell',
            detail: 'npm test',
            state: 'done'
          })
          output('Looks green\nFAROL_PIPELINES: []\n')
          return 0
        }
      )
      .mockImplementationOnce(
        async (
          _request: AgentTaskRequest,
          _prompt: string,
          output: (chunk: string) => void
        ) => {
          output('FAROL_PIPELINES: ["validate"]\n')
          return 0
        }
      )
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start(request)
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(
        true
      )
    )

    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][1]).toContain('bypassed pipelines')
    expect(execute.mock.calls[1][1]).toContain('npm test')
    expect(execute.mock.calls[1][1]).toContain('FAROL_PIPELINES: ["validate"]')
    expect(run.mock.calls.map((call) => call[0].id)).toEqual(['validate'])
  })

  it('allows catalog shell self-runs when the owning pipeline is still selected', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn().mockResolvedValue(result(true))
    const execute = vi.fn().mockImplementation(
      async (
        _request: AgentTaskRequest,
        _prompt: string,
        output: (chunk: string) => void,
        onTool?: (event: {
          toolId: string
          name: string
          detail?: string
          state: 'running' | 'done' | 'error'
        }) => void
      ) => {
        onTool?.({
          toolId: 'shell-1',
          name: 'command_execution',
          detail: 'npm test',
          state: 'done'
        })
        output('FAROL_PIPELINES: ["validate"]\n')
        return 0
      }
    )
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start(request)
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(
        true
      )
    )

    expect(execute).toHaveBeenCalledTimes(1)
    expect(run.mock.calls.map((call) => call[0].id)).toEqual(['validate'])
  })

  it('auto-runs mandatory pipelines even when the agent omits them', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn().mockResolvedValue(result(true))
    const execute = selecting('validate')
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start({ ...request, pipelines: [request.pipelines[0], lintMandatory] })
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )

    expect(run.mock.calls.map((call) => call[0].id)).toEqual(['lint', 'validate'])
    expect(execute.mock.calls[0][1]).toContain('[mandatory]')
    expect(execute.mock.calls[0][1]).toContain('Mandatory pipelines')
  })

  it('rejects empty FAROL_PIPELINES when mandatory pipelines exist and code changed', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn().mockResolvedValue(result(true))
    const execute = vi
      .fn<AgentExecutor>()
      .mockImplementationOnce(async (_request, _prompt, output, onTool) => {
        onTool?.({ toolId: 'edit-1', name: 'apply_patch', detail: 'src/app.ts', state: 'done' })
        output('Done\nFAROL_PIPELINES: []\n')
        return 0
      })
      .mockImplementationOnce(async (_request, _prompt, output) => {
        output('FAROL_PIPELINES: ["validate"]\n')
        return 0
      })
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start({ ...request, pipelines: [request.pipelines[0], lintMandatory] })
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )

    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][1]).toContain('skipped mandatory pipelines')
    expect(run.mock.calls.map((call) => call[0].id)).toEqual(['lint', 'validate'])
  })

  it('allows empty FAROL_PIPELINES with mandatory pipelines when no code changed', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn().mockResolvedValue(result(true))
    const execute = selecting()
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start({ ...request, pipelines: [lintMandatory] })
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )

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

  it('rejects empty FAROL_PIPELINES on a repair turn after a failed mandatory run', async () => {
    const events: AgentTaskEvent[] = []
    const lintFail = {
      runId: 'run-lint-fail',
      pipelineId: 'lint',
      ok: false,
      failedNodeId: 'lint-step',
      steps: [{ nodeId: 'lint-step', ok: false, code: 1, output: 'lint error' }]
    }
    const lintPass = { ...lintFail, runId: 'run-lint-ok', ok: true, failedNodeId: undefined, steps: [{ nodeId: 'lint-step', ok: true, code: 0, output: '' }] }
    const run = vi
      .fn()
      .mockResolvedValueOnce(lintFail)
      .mockResolvedValueOnce(result(true))
      .mockResolvedValueOnce(lintPass)
      .mockResolvedValueOnce(result(true))
    const execute = vi
      .fn<AgentExecutor>()
      .mockImplementationOnce(async (_request, _prompt, output, onTool) => {
        onTool?.({ toolId: 'edit-1', name: 'apply_patch', detail: 'src/app.ts', state: 'done' })
        output('FAROL_PIPELINES: ["validate"]\n')
        return 0
      })
      .mockImplementationOnce(async (_request, _prompt, output) => {
        output('No further edits\nFAROL_PIPELINES: []\n')
        return 0
      })
      .mockImplementationOnce(async (_request, _prompt, output) => {
        output('FAROL_PIPELINES: ["validate"]\n')
        return 0
      })
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start({ ...request, pipelines: [request.pipelines[0], lintMandatory] })
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )

    expect(execute).toHaveBeenCalledTimes(3)
    expect(execute.mock.calls[1][1]).toContain('Farol validation attempt')
    expect(execute.mock.calls[2][1]).toContain('skipped mandatory pipelines')
    expect(run.mock.calls.map((call) => call[0].id)).toEqual(['lint', 'validate', 'lint', 'validate'])
  })

  it('treats NotebookEdit as a code change and rejects empty FAROL_PIPELINES', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn().mockResolvedValue(result(true))
    const execute = vi
      .fn<AgentExecutor>()
      .mockImplementationOnce(async (_request, _prompt, output, onTool) => {
        onTool?.({ toolId: 'nb-1', name: 'NotebookEdit', detail: 'notes.ipynb', state: 'done' })
        output('FAROL_PIPELINES: []\n')
        return 0
      })
      .mockImplementationOnce(async (_request, _prompt, output) => {
        output('FAROL_PIPELINES: ["validate"]\n')
        return 0
      })
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start({ ...request, pipelines: [request.pipelines[0], lintMandatory] })
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )

    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][1]).toContain('skipped mandatory pipelines')
    expect(run.mock.calls.map((call) => call[0].id)).toEqual(['lint', 'validate'])
  })

  it('does not treat CreateGoal as a code change', async () => {
    const events: AgentTaskEvent[] = []
    const run = vi.fn().mockResolvedValue(result(true))
    const execute = vi.fn<AgentExecutor>().mockImplementation(async (_request, _prompt, output, onTool) => {
      onTool?.({ toolId: 'goal-1', name: 'CreateGoal', detail: 'Ship the widget', state: 'done' })
      output('FAROL_PIPELINES: []\n')
      return 0
    })
    const controller = new AgentController({ run }, (event) => events.push(event), execute)

    controller.start({ ...request, pipelines: [lintMandatory] })
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true)
    )

    expect(execute).toHaveBeenCalledTimes(1)
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
})
