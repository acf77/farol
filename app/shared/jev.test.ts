import { describe, expect, it } from 'vitest'
import {
  decide,
  decideSelection,
  describePipeline,
  JEV_CONFIDENCE,
  JEV_PROBE,
  JEV_SELECTION_THRESHOLD,
  pipelineSelectionQuestions,
  pipelineSelectionState
} from './jev'
import type { Pipeline } from './types'

function pipeline(
  id: string,
  opts: { mandatory?: boolean; autoSelectable?: boolean; cmd?: string; name?: string } = {}
): Pipeline {
  return {
    id,
    name: opts.name ?? id,
    nodes: [
      {
        id: `${id}-n`,
        name: 'Step',
        type: 'shell',
        cmd: opts.cmd ?? `run ${id}`,
        after: [],
        x: 0,
        y: 0
      }
    ],
    ...(opts.mandatory ? { mandatory: true } : {}),
    ...(opts.autoSelectable ? { autoSelectable: true } : {})
  }
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

describe('decideSelection', () => {
  it('adds only at or above the selection threshold', () => {
    expect(decideSelection(answer(JEV_SELECTION_THRESHOLD))).toBe(true)
    expect(decideSelection(answer(0.99))).toBe(true)
    expect(decideSelection(answer(0.84))).toBe(false)
    expect(decideSelection(answer(0.3))).toBe(false)
    expect(decideSelection(answer(0.01))).toBe(false)
  })

  it('treats non-finite probabilities as do-not-add', () => {
    expect(decideSelection(answer(NaN))).toBe(false)
  })
})

describe('describePipeline', () => {
  it('includes name, id, step type, and a truncated command', () => {
    const long = 'x'.repeat(200)
    const text = describePipeline(pipeline('sec', { name: 'Security', cmd: long }))
    expect(text).toContain('Security (sec)')
    expect(text).toContain('[shell]')
    expect(text.length).toBeLessThanOrEqual(600)
    expect(text).toContain('…')
  })

  it('marks remote pipelines so Jev does not treat them as local', () => {
    expect(describePipeline({ ...pipeline('r'), target: 'vercel' })).toContain('[remote: Vercel Sandbox]')
    expect(describePipeline(pipeline('r'))).not.toContain('remote')
  })
})

describe('pipelineSelectionState', () => {
  it('includes task, changed targets, and coverage already scheduled', () => {
    const state = pipelineSelectionState({
      task: 'Harden auth',
      assistant: 'Patched login.ts',
      changedTargets: ['src/login.ts'],
      selected: [pipeline('docs', { autoSelectable: true, name: 'Docs' })],
      mandatory: [pipeline('lint', { mandatory: true, name: 'Lint' })]
    })
    expect(state).toContain('Task: Harden auth')
    expect(state).toContain('src/login.ts')
    expect(state).toContain('Docs (docs)')
    expect(state).toContain('Lint (lint)')
    expect(state).toContain('Patched login.ts')
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
  it('asks only about opted-in, non-mandatory candidates', () => {
    const questions = pipelineSelectionQuestions([
      pipeline('lint', { mandatory: true, autoSelectable: true }),
      pipeline('security', { autoSelectable: true, name: 'Security Scan' }),
      pipeline('release')
    ])
    expect(Object.keys(questions)).toEqual(['security'])
    expect(questions.security.instructions).toContain('Security Scan (security)')
    expect(questions.security.instructions).toContain('[shell]')
    expect(questions.security.criteria?.true).toMatch(/material coverage/i)
    expect(questions.security.criteria?.false).toMatch(/release|mutations/i)
  })

  it('asks nothing when no candidate is auto-selectable', () => {
    expect(pipelineSelectionQuestions([pipeline('release'), pipeline('lint', { mandatory: true })])).toEqual(
      {}
    )
  })
})
