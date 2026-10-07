import { describe, expect, it } from 'vitest'
import { resolveAiStepAttempt } from './ai-step-attempt'

describe('resolveAiStepAttempt', () => {
  it('does not fallback when the step explicitly failed', () => {
    expect(
      resolveAiStepAttempt(
        { exit: 1, verdict: 'fail', output: 'Risk: rate limit handling is broken.' },
        0,
        2
      )
    ).toBe(1)
  })

  it('continues the chain on provider failure without an explicit verdict', () => {
    expect(
      resolveAiStepAttempt({ exit: 1, verdict: null, output: 'rate limit exceeded' }, 0, 2)
    ).toBe(null)
  })
})
