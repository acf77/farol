import { describe, expect, it } from 'vitest'
import { decide, JEV_CONFIDENCE, JEV_PROBE, pipelineSelectionQuestions } from './jev'
import type { Pipeline } from './types'

function pipeline(id: string, mandatory?: boolean): Pipeline {
  return { id, name: id, nodes: [], ...(mandatory ? { mandatory } : {}) }
}

const answer = (probability: number) => ({ type: 'boolean' as const, probability })

describe('decide', () => {
  it('reads a confident probability as a verdict', () => {
    expect(decide(answer(0.99))).toBe(true)
    expect(decide(answer(0.01))).toBe(false)
    expect(decide(answer(JEV_CONFIDENCE))).toBe(true)
    expect(decide(answer(1 - JEV_CONFIDENCE))).toBe(false)
  })

  it('leaves the band between the bounds undecided', () => {
    expect(decide(answer(0.5))).toBe(null)
    expect(decide(answer(0.84))).toBe(null)
    expect(decide(answer(0.16))).toBe(null)
  })

  it('takes a stricter or looser bar', () => {
    expect(decide(answer(0.7), 0.6)).toBe(true)
    expect(decide(answer(0.9), 0.95)).toBe(null)
  })

  it('refuses a probability that is not a number', () => {
    expect(decide(answer(NaN))).toBe(null)
    expect(decide(answer(Infinity))).toBe(null)
  })
})

describe('JEV_PROBE', () => {
  it('asks one boolean question whose true case is the failing one', () => {
    expect(Object.keys(JEV_PROBE.questions)).toEqual(['failed'])
    expect(JEV_PROBE.questions.failed.type).toBe('boolean')
    expect(JEV_PROBE.state).toContain('exited with code 1')
  })
})

describe('pipelineSelectionQuestions', () => {
  it('asks one question per candidate, keyed by its id', () => {
    const questions = pipelineSelectionQuestions([pipeline('lint'), pipeline('security')])
    expect(Object.keys(questions)).toEqual(['lint', 'security'])
    expect(questions.lint.instructions).toContain('"lint" (lint)')
  })

  it('never asks about a mandatory pipeline', () => {
    const questions = pipelineSelectionQuestions([pipeline('lint', true), pipeline('security')])
    expect(Object.keys(questions)).toEqual(['security'])
  })

  it('asks nothing when every candidate is mandatory', () => {
    expect(pipelineSelectionQuestions([pipeline('lint', true)])).toEqual({})
  })
})
