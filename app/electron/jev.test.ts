import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pipeline } from '../shared/types'

const { peekSecret, evaluate } = vi.hoisted(() => ({
  peekSecret: vi.fn(),
  evaluate: vi.fn()
}))
vi.mock('./secrets', () => ({ peekSecret, setSecret: vi.fn(), clearSecret: vi.fn() }))
vi.mock('ai', () => ({ experimental_evaluate: evaluate }))
vi.mock('./store', () => ({ loadSettings: vi.fn() }))

import { selectPipelines, verdictFromOutput } from './jev'

beforeEach(() => {
  peekSecret.mockReset()
  evaluate.mockReset()
})

function pipeline(id: string, mandatory?: boolean): Pipeline {
  return { id, name: id, nodes: [], ...(mandatory ? { mandatory } : {}) }
}

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
