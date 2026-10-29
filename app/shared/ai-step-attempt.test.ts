import { describe, expect, it } from 'vitest'
import { resolveAiStepAttempt } from './ai-step-attempt'
import { providerFailure } from './provider-failure'

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

describe('providerFailure', () => {
  it('matches CLI banners', () => {
    expect(providerFailure('Error: rate limit exceeded')).toBe('rate limit exceeded')
    expect(providerFailure('API Error: 429 Too Many Requests')).toBe('Error: 429')
  })

  it('ignores a bare 429 inside ordinary text', () => {
    expect(providerFailure('see agent-controller.ts line 429 for the retry')).toBeNull()
    expect(providerFailure('processed 429 files')).toBeNull()
  })
})
