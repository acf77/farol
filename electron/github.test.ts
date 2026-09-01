import { describe, expect, it } from 'vitest'
import { mapCheckState, rollupCounts } from './github'

describe('mapCheckState', () => {
  it('maps GitHub check states', () => {
    expect(mapCheckState('SUCCESS')).toBe('pass')
    expect(mapCheckState('FAILURE')).toBe('fail')
    expect(mapCheckState('SKIPPED')).toBe('skip')
    expect(mapCheckState('PENDING')).toBe('pending')
  })
})

describe('rollupCounts', () => {
  it('counts failed and pending contexts', () => {
    expect(
      rollupCounts({
        contexts: [
          { state: 'SUCCESS' },
          { state: 'FAILURE' },
          { state: 'PENDING' }
        ]
      })
    ).toEqual({ hasChecks: true, checksFailed: 1, checksPending: 1 })
  })

  it('uses rollup state when contexts are missing', () => {
    expect(rollupCounts({ state: 'FAILURE' })).toEqual({
      hasChecks: true,
      checksFailed: 1,
      checksPending: 0
    })
  })

  it('reports no checks when rollup is empty', () => {
    expect(rollupCounts(undefined)).toEqual({
      hasChecks: false,
      checksFailed: 0,
      checksPending: 0
    })
  })
})
