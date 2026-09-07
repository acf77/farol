import { describe, expect, it } from 'vitest'
import { exitCodeFromSignal } from './exit-code'

describe('exitCodeFromSignal', () => {
  it('reports an out-of-memory abort as 134, not a cancellation', () => {
    // Node calls abort() when the heap is exhausted; 130 would read as Ctrl-C.
    expect(exitCodeFromSignal('SIGABRT')).toBe(134)
  })

  it('uses the shell convention of 128 + signum', () => {
    expect(exitCodeFromSignal('SIGINT')).toBe(130)
    expect(exitCodeFromSignal('SIGKILL')).toBe(137)
    expect(exitCodeFromSignal('SIGTERM')).toBe(143)
    expect(exitCodeFromSignal('SIGSEGV')).toBe(139)
  })

  it('accepts the numeric signals node-pty reports', () => {
    expect(exitCodeFromSignal(6)).toBe(134)
    expect(exitCodeFromSignal(9)).toBe(137)
  })

  it('returns null when no signal killed the process', () => {
    expect(exitCodeFromSignal(null)).toBeNull()
    expect(exitCodeFromSignal(undefined)).toBeNull()
    expect(exitCodeFromSignal(0)).toBeNull()
    expect(exitCodeFromSignal('')).toBeNull()
    expect(exitCodeFromSignal('SIGNOTREAL')).toBeNull()
  })
})
