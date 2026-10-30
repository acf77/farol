import { describe, expect, it } from 'vitest'
import { FEEDBACK_NUDGE_KEY, createNudgeSlot, nudgeDone } from './feedback-nudge'

describe('feedback nudge', () => {
  it('asks on the first green card only', () => {
    const slot = createNudgeSlot()
    expect(slot.claim('run-1', false)).toBe(false)
    expect(slot.claim('run-2', true)).toBe(true)
    expect(slot.claim('run-3', true)).toBe(false)
  })

  it('keeps asking on the same card when it renders again', () => {
    const slot = createNudgeSlot()
    expect(slot.claim('run-1', true)).toBe(true)
    expect(slot.claim('run-1', true)).toBe(true)
  })

  it('waits for a running card to pass before it claims', () => {
    const slot = createNudgeSlot()
    expect(slot.claim('run-1', false)).toBe(false)
    expect(slot.claim('run-1', true)).toBe(true)
  })

  it('stays quiet once handled, or when storage is unavailable', () => {
    expect(nudgeDone({ getItem: (k) => (k === FEEDBACK_NUDGE_KEY ? '1' : null) })).toBe(true)
    expect(nudgeDone({ getItem: () => null })).toBe(false)
    expect(nudgeDone({ getItem: () => { throw new Error('blocked') } })).toBe(true)
    expect(nudgeDone(undefined)).toBe(false)
  })
})
