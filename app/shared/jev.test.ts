import { describe, expect, it } from 'vitest'
import {
  acceptPreparedChoice,
  choiceProbability,
  decide,
  describePipeline,
  fingerprintIds,
  JEV_CONFIDENCE,
  JEV_PROBE,
  JEV_SELECTION_THRESHOLD,
  PIPELINE_NONE_ID,
  pipelineSelectionQuestions,
  pipelineSelectionState,
  preparePipelineChoice
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

describe('acceptPreparedChoice', () => {
  const prepared = ['security', 'docs', PIPELINE_NONE_ID]
  const fingerprint = fingerprintIds(prepared)

  it('accepts a prepared id at or above the selection threshold', () => {
    expect(
      acceptPreparedChoice(
        { type: 'choice', choice: 'security', probabilities: { security: 0.9, docs: 0.05, none: 0.05 } },
        prepared,
        { fingerprint, currentFingerprint: fingerprint, threshold: JEV_SELECTION_THRESHOLD }
      )
    ).toBe('security')
  })

  it('rejects foreign ids, fingerprint drift, and low winning probability', () => {
    expect(
      acceptPreparedChoice(
        { type: 'choice', choice: 'ghost', probabilities: { ghost: 0.99 } },
        prepared,
        { fingerprint, currentFingerprint: fingerprint }
      )
    ).toBe(null)
    expect(
      acceptPreparedChoice(
        { type: 'choice', choice: 'security', probabilities: { security: 0.99 } },
        prepared,
        { fingerprint, currentFingerprint: 'other' }
      )
    ).toBe(null)
    expect(
      acceptPreparedChoice(
        { type: 'choice', choice: 'security', probabilities: { security: 0.5 } },
        prepared,
        { fingerprint, currentFingerprint: fingerprint }
      )
    ).toBe(null)
  })

  it('accepts when no distribution is supplied (host still checks membership)', () => {
    expect(
      acceptPreparedChoice({ type: 'choice', choice: 'none' }, prepared, {
        fingerprint,
        currentFingerprint: fingerprint
      })
    ).toBe('none')
  })
})

describe('choiceProbability', () => {
  it('reads the winning option from the distribution', () => {
    expect(
      choiceProbability({
        type: 'choice',
        choice: 'implement',
        probabilities: { implement: 0.91, inspect: 0.09 }
      })
    ).toBe(0.91)
    expect(choiceProbability({ type: 'choice', choice: 'implement' })).toBeUndefined()
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
    expect(describePipeline({ ...pipeline('r'), target: 'remote' })).toContain('[remote]')
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
  it('asks one Choice over opted-in candidates plus none', () => {
    const questions = pipelineSelectionQuestions([
      pipeline('lint', { mandatory: true, autoSelectable: true }),
      pipeline('security', { autoSelectable: true, name: 'Security Scan' }),
      pipeline('release')
    ])
    expect(Object.keys(questions)).toEqual(['pipeline'])
    expect(questions.pipeline.type).toBe('choice')
    expect(Object.keys(questions.pipeline.criteria).sort()).toEqual(['none', 'security'])
    expect(questions.pipeline.criteria.security).toContain('Security Scan (security)')
    expect(questions.pipeline.criteria.none).toMatch(/Do not add/i)
  })

  it('asks nothing when no candidate is auto-selectable', () => {
    expect(pipelineSelectionQuestions([pipeline('release'), pipeline('lint', { mandatory: true })])).toEqual(
      {}
    )
    expect(preparePipelineChoice([pipeline('release')])).toBe(null)
  })
})
