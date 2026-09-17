import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pipeline } from '../shared/types'

const { peekSecret, evaluate } = vi.hoisted(() => ({
  peekSecret: vi.fn(),
  evaluate: vi.fn()
}))
vi.mock('./secrets', () => ({ peekSecret, setSecret: vi.fn(), clearSecret: vi.fn() }))
vi.mock('ai', () => ({ experimental_evaluate: evaluate }))
vi.mock('./store', () => ({ loadSettings: vi.fn() }))

import { checkJev, selectPipelines, verdictFromOutput } from './jev'

beforeEach(() => {
  peekSecret.mockReset()
  evaluate.mockReset()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

function pipeline(id: string, mandatory?: boolean): Pipeline {
  return { id, name: id, nodes: [], ...(mandatory ? { mandatory } : {}) }
}

describe('Jev decision logs', () => {
  it('records each requested decision without logging keys, state, or unexpected answers', async () => {
    peekSecret.mockReturnValue('secret-key')
    evaluate.mockResolvedValue({
      answers: {
        yes: { type: 'boolean', probability: 0.99 },
        no: { type: 'boolean', probability: 0.01 },
        unsure: { type: 'boolean', probability: 0.5 },
        unexpected: { type: 'boolean', probability: 1 }
      }
    })
    expect(await selectPipelines(['yes', 'no', 'unsure', 'missing'].map((id) => pipeline(id)), 'private-state'))
      .toEqual(['yes'])
    expect(console.info).toHaveBeenCalledExactlyOnceWith('[farol] Jev', expect.objectContaining({
      purpose: 'pipeline-selection',
      status: 'evaluated',
      confidence: 0.85,
      durationMs: expect.any(Number),
      decisions: [
        { id: 'yes', probability: 0.99, decision: true, reason: 'confident' },
        { id: 'no', probability: 0.01, decision: false, reason: 'confident' },
        { id: 'unsure', probability: 0.5, decision: null, reason: 'inconclusive' },
        { id: 'missing', probability: null, decision: null, reason: 'missing-answer' }
      ]
    }))
    const logged = JSON.stringify(vi.mocked(console.info).mock.calls)
    for (const text of ['secret-key', 'private-state', 'unexpected']) expect(logged).not.toContain(text)
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
    const logged = JSON.stringify(vi.mocked(console.info).mock.calls)
    expect(logged).not.toContain('private-state')
    expect(logged).not.toContain('secret-key')
  })

  it('records a skipped selection when no optional candidates remain', async () => {
    await selectPipelines([pipeline('lint', true)], 'private-state')
    expect(console.info).toHaveBeenCalledExactlyOnceWith('[farol] Jev', expect.objectContaining({
      purpose: 'pipeline-selection',
      status: 'skipped',
      reason: 'no-candidates'
    }))
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
  it('returns the ids Jev was confident should run', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockResolvedValue({
      answers: {
        security: { type: 'boolean', probability: 0.99 },
        docs: { type: 'boolean', probability: 0.01 }
      }
    })
    const ids = await selectPipelines([pipeline('security'), pipeline('docs')], 'the diff touched auth code')
    expect(ids).toEqual(['security'])
  })

  it('never invents an id outside the candidates it was given', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockResolvedValue({
      answers: { security: { type: 'boolean', probability: 0.99 }, ghost: { type: 'boolean', probability: 0.99 } }
    })
    const ids = await selectPipelines([pipeline('security')], 'state')
    expect(ids).toEqual(['security'])
  })

  it('drops an answer key that was never asked about, even if the gateway sends one', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockResolvedValue({ answers: { ghost: { type: 'boolean', probability: 0.99 } } })
    const ids = await selectPipelines([pipeline('security')], 'state')
    expect(ids).toEqual([])
  })

  it('asks nothing and returns null when every candidate is mandatory', async () => {
    peekSecret.mockReturnValue('a-key')
    expect(await selectPipelines([pipeline('lint', true)], 'state')).toBe(null)
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('falls back to null when no key is stored', async () => {
    peekSecret.mockReturnValue(null)
    expect(await selectPipelines([pipeline('security')], 'state')).toBe(null)
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('fails soft when the gateway call throws', async () => {
    peekSecret.mockReturnValue('a-key')
    evaluate.mockRejectedValue(new Error('gateway is down'))
    expect(await selectPipelines([pipeline('security')], 'state')).toBe(null)
  })
})
