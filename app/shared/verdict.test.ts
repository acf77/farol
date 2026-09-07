import { describe, expect, it } from 'vitest'
import { parseVerdict, stripVerdictLine, VERDICT_MARKER } from './verdict'

describe('parseVerdict', () => {
  it('reads pass and fail markers from AI output', () => {
    expect(parseVerdict(`Looks good.\n${VERDICT_MARKER} pass`)).toBe('pass')
    expect(parseVerdict(`Issues found.\n${VERDICT_MARKER} fail`)).toBe('fail')
  })

  it('uses the last marker when the model mentions earlier ones in prose', () => {
    expect(parseVerdict(`Do not print ${VERDICT_MARKER} fail yet.\n${VERDICT_MARKER} pass`)).toBe('pass')
  })

  it('accepts common synonyms', () => {
    expect(parseVerdict(`${VERDICT_MARKER} PASSED`)).toBe('pass')
    expect(parseVerdict(`${VERDICT_MARKER} failed`)).toBe('fail')
  })

  it('returns null when no marker was printed', () => {
    expect(parseVerdict('All checks green.')).toBeNull()
  })
})

describe('stripVerdictLine', () => {
  it('removes verdict control lines from streamed log text', () => {
    expect(stripVerdictLine(`Review complete\n${VERDICT_MARKER} pass\n`)).toBe('Review complete\n')
  })
})
