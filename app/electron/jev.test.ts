import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Pipeline } from '../shared/types'
import { toolFocusFingerprint } from '../shared/tool-policy'

const { peekSecret, evaluate } = vi.hoisted(() => ({
  peekSecret: vi.fn(),
  evaluate: vi.fn()
}))
vi.mock('./secrets', () => ({ peekSecret, setSecret: vi.fn(), clearSecret: vi.fn() }))
vi.mock('ai', () => ({ experimental_evaluate: evaluate }))
vi.mock('./store', () => ({ loadSettings: vi.fn() }))

import { checkJev, selectPipelines, selectTools, verdictFromOutput } from './jev'
import { configureJevLogs, jevLogPath } from './jev-log'

let logRoot: string

beforeEach(() => {
  peekSecret.mockReset()
  evaluate.mockReset()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-jev-'))
  configureJevLogs(() => logRoot)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(logRoot, { recursive: true, force: true })
})

function pipeline(id: string, opts: { mandatory?: boolean; autoSelectable?: boolean } = {}): Pipeline {
  return {
    id,
    name: id,
    nodes: [],
    ...(opts.mandatory ? { mandatory: true } : {}),
    ...(opts.autoSelectable ? { autoSelectable: true } : {})
  }
}

function readJevLog(): Record<string, unknown>[] {
  const file = jevLogPath()
  expect(file).toBeTruthy()
  const raw = fs.readFileSync(file!, 'utf8').trim()
  if (!raw) return []
  return raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

function pipelineChoice(
  winner: string,
  opts: Record<string, number> = {}
): { type: 'choice'; choice: string; probabilities: Record<string, number> } {
  const probabilities = { none: 0.01, ...opts, [winner]: opts[winner] ?? 0.95 }
  return { type: 'choice', choice: winner, probabilities }
}

describe('Jev decision logs', () => {
  it('records selection Choice outcomes without logging state or keys', async () => {
    peekSecret.mockReturnValue('secret-key')
    evaluate.mockResolvedValue({
      answers: {
        pipeline: pipelineChoice('yes', { yes: 0.95, no: 0.02, unsure: 0.02, missing: 0.01, none: 0.0 })
      }
    })
    const candidates = ['yes', 'no', 'unsure', 'missing'].map((id) =>
      pipeline(id, { autoSelectable: true })
    )
    expect(await selectPipelines(candidates, 'private-state', { attempt: 2 })).toEqual(['yes'])
    const entry = {
      purpose: 'pipeline-selection',
      status: 'evaluated',
      threshold: 0.85,
      attempt: 2,
      stateChars: 'private-state'.length,
      selected: ['yes'],
      choice: 'yes',
      outcome: 'selected',
      durationMs: expect.any(Number)
    }
    expect(console.info).toHaveBeenCalledExactlyOnceWith('[farol] Jev', expect.objectContaining(entry))
    expect(readJevLog()).toEqual([expect.objectContaining(entry)])
    const logged = JSON.stringify([...vi.mocked(console.info).mock.calls, ...readJevLog()])
    for (const text of ['secret-key', 'private-state']) expect(logged).not.toContain(text)
  })

  it.each([
    ['no-key', null, undefined],
    ['evaluation-error', 'secret-key', new Error('private-state secret-key')],
    ['timeout', 'secret-key', new DOMException('private-state', 'TimeoutError')]
  ])('records the %s fallback without leaking error details', async (reason, key, error) => {
    peekSecret.mockReturnValue(key)
    evaluate.mockRejectedValue(error)
    expect(await verdictFromOutput('private-state')).toBe(null)
    expect(console.info).toHaveBeenCalledExactlyOnceWith('[farol] Jev', expect.objectContaining({
      purpose: 'step-verdict',
      reason
    }))
    expect(readJevLog()).toEqual([expect.objectContaining({ purpose: 'step-verdict', reason })])
    const logged = JSON.stringify([...vi.mocked(console.info).mock.calls, ...readJevLog()])
    expect(logged).not.toContain('private-state')
    expect(logged).not.toContain('secret-key')
  })

  it('records a skipped selection when no opted-in candidates remain', async () => {
    await selectPipelines([pipeline('lint', { mandatory: true }), pipeline('release')], 'private-state')
    expect(console.info).toHaveBeenCalledExactlyOnceWith('[farol] Jev', expect.objectContaining({
      purpose: 'pipeline-selection',
      status: 'skipped',
      reason: 'no-candidates'
    }))
    expect(readJevLog()).toEqual([expect.objectContaining({
      purpose: 'pipeline-selection',
      status: 'skipped',
      reason: 'no-candidates'
    })])
  })

  it('identifies Settings probe decisions', async () => {
    peekSecret.mockReturnValue('secret-key')
    evaluate.mockResolvedValue({ answers: { failed: { type: 'boolean', probability: 0.99 } } })
    await checkJev()
    expect(console.info).toHaveBeenCalledExactlyOnceWith('[farol] Jev', expect.objectContaining({
      purpose: 'settings-probe',
      status: 'evaluated',
      decisions: [{ id: 'failed', probability: 0.99, decision: true, reason: 'confident' }]
    }))
    expect(readJevLog()).toEqual([expect.objectContaining({ purpose: 'settings-probe' })])
  })
})

describe('verdictFromOutput', () => {
  it('falls back to null when no key is stored, so the runner keeps the exit code', async () => {
    peekSecret.mockReturnValue(null)
    expect(await verdictFromOutput('some output')).toBe(null)
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('reads a confident pass', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockResolvedValue({ answers: { passed: { type: 'boolean', probability: 0.99 } } })
    expect(await verdictFromOutput('all checks succeeded')).toBe('pass')
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: {
          passed: expect.objectContaining({
            type: 'boolean',
            instructions: expect.stringContaining('near 1.0 or near 0.0'),
            criteria: expect.objectContaining({
              true: expect.stringContaining('blocking findings'),
              false: expect.stringContaining('required fixes')
            })
          })
        }
      })
    )
  })

  it('reads a confident fail', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockResolvedValue({ answers: { passed: { type: 'boolean', probability: 0.01 } } })
    expect(await verdictFromOutput('error: something broke')).toBe('fail')
  })

  it('reads an inconclusive answer as null instead of guessing', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockResolvedValue({ answers: { passed: { type: 'boolean', probability: 0.5 } } })
    expect(await verdictFromOutput('ambiguous output')).toBe(null)
  })

  it('fails soft when the gateway call throws', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockRejectedValue(new Error('gateway is down'))
    expect(await verdictFromOutput('some output')).toBe(null)
  })
})

describe('selectPipelines', () => {
  it('returns the one pipeline Choice winner', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockResolvedValue({
      answers: { pipeline: pipelineChoice('security', { security: 0.92, docs: 0.04, none: 0.04 }) }
    })
    const ids = await selectPipelines(
      [pipeline('security', { autoSelectable: true }), pipeline('docs', { autoSelectable: true })],
      'the diff touched auth code'
    )
    expect(ids).toEqual(['security'])
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: {
          pipeline: expect.objectContaining({
            type: 'choice',
            criteria: expect.objectContaining({
              security: expect.any(String),
              docs: expect.any(String),
              none: expect.any(String)
            })
          })
        }
      })
    )
  })

  it('never invents an id outside the candidates it was given', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockResolvedValue({
      answers: { pipeline: pipelineChoice('ghost', { ghost: 0.99, security: 0.01 }) }
    })
    const ids = await selectPipelines([pipeline('security', { autoSelectable: true })], 'state')
    expect(ids).toEqual([])
  })

  it('treats none as add-nothing', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockResolvedValue({
      answers: { pipeline: pipelineChoice('none', { none: 0.9, security: 0.1 }) }
    })
    expect(await selectPipelines([pipeline('security', { autoSelectable: true })], 'state')).toEqual([])
  })

  it('asks nothing and returns null when no candidate is auto-selectable', async () => {
    peekSecret.mockReturnValue('a-key')
    expect(await selectPipelines([pipeline('lint', { mandatory: true }), pipeline('release')], 'state')).toBe(
      null
    )
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('cannot auto-select a release pipeline that was not opted in, even if the gateway is eager', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockResolvedValue({
      answers: { pipeline: pipelineChoice('release', { release: 0.99 }) }
    })
    expect(await selectPipelines([pipeline('release')], 'please bump and ship')).toBe(null)
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('falls back to null when no key is stored', async () => {
    peekSecret.mockReturnValue(null)
    expect(await selectPipelines([pipeline('security', { autoSelectable: true })], 'state')).toBe(null)
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('fails soft when the gateway call throws', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockRejectedValue(new Error('gateway is down'))
    expect(await selectPipelines([pipeline('security', { autoSelectable: true })], 'state')).toBe(null)
  })
})

describe('selectTools', () => {
  it('maps a confident focus Choice onto kept/omitted families', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockResolvedValue({
      answers: {
        focus: {
          type: 'choice',
          choice: 'implement',
          probabilities: { inspect: 0.02, implement: 0.92, verify: 0.03, answer: 0.03 }
        }
      }
    })
    expect(await selectTools('Mode: build\nTask: patch the login form')).toEqual({
      kind: 'selected',
      focus: 'implement',
      kept: ['edit', 'shell'],
      omitted: ['web'],
      candidatesFingerprint: toolFocusFingerprint('build')
    })
  })

  it('fails soft (null → full tools) on low confidence in Build', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockResolvedValue({
      answers: {
        focus: {
          type: 'choice',
          choice: 'inspect',
          probabilities: { inspect: 0.4, implement: 0.3, verify: 0.2, answer: 0.1 }
        }
      }
    })
    expect(await selectTools('state')).toBe(null)
  })

  it('soft-fails Plan to inspect, never full tools', async () => {
    peekSecret.mockReturnValue(null)
    expect(await selectTools('Mode: plan\nTask: outline a fix', { mode: 'plan' })).toEqual({
      kind: 'plan',
      focus: 'inspect',
      candidatesFingerprint: toolFocusFingerprint('plan')
    })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('picks a Plan answer focus when Jev is confident', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockResolvedValue({
      answers: {
        focus: {
          type: 'choice',
          choice: 'answer',
          probabilities: { inspect: 0.1, answer: 0.9 }
        }
      }
    })
    expect(await selectTools('Mode: plan\nTask: summarize', { mode: 'plan' })).toEqual({
      kind: 'plan',
      focus: 'answer',
      candidatesFingerprint: toolFocusFingerprint('plan')
    })
  })

  it('falls back to null when no key is stored in Build', async () => {
    peekSecret.mockReturnValue(null)
    expect(await selectTools('state')).toBe(null)
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('fails soft when the gateway call throws in Build', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockRejectedValue(new Error('gateway is down'))
    expect(await selectTools('state')).toBe(null)
  })
})
