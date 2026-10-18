import { describe, expect, it } from 'vitest'
import type { RunResult, RunResultStep, RunStepStatus } from './run-result'
import { createFallback, exitCode, fallbackLine, localSteps, remotePassed, topupOnce } from './remote-fallback'

const step = (id: string, status: RunStepStatus): RunResultStep => ({ id, name: id, status, output: '', outputTruncated: false })

const result = (statuses: Record<string, RunStepStatus>, extra: Partial<RunResult> = {}): RunResult => ({
  schema: 1,
  runId: 'r1',
  status: 'failed',
  source: { kind: 'snapshot', sha256: 'x', bytes: 1 },
  pipeline: { id: 'p', name: 'p' },
  createdAt: '2026-01-01T00:00:00Z',
  steps: Object.entries(statuses).map(([id, status]) => step(id, status)),
  ...extra
})

describe('create refusal', () => {
  it('402 with fallback runs the whole pipeline locally and the top-up URL prints once', () => {
    const fallback = createFallback(402, { fallback: 'local', topupUrl: 'https://pay.test/top' })
    expect(fallback).toEqual({ topupUrl: 'https://pay.test/top' })
    const once = topupOnce()
    expect(once(fallback?.topupUrl)).toBe('https://pay.test/top')
    expect(once(fallback?.topupUrl)).toBeNull()
  })

  it('422 with fallback runs locally; without it, or on a 402 without it, the old failure stands', () => {
    expect(createFallback(422, { fallback: 'local' })).toEqual({})
    expect(createFallback(422, {})).toBeNull()
    expect(createFallback(402, {})).toBeNull()
  })
})

describe('stream', () => {
  it('prints one short line for ai-fallback only', () => {
    expect(fallbackLine('ai-fallback', { nodeId: 'a' })).toBe('Credits ended. Step a will run locally.')
    expect(fallbackLine('step-end', { nodeId: 'a' })).toBeNull()
  })

  it('runs localNodeIds in order, then the pending and skipped steps after the needs-local step', () => {
    const run = result({ s: 'passed', a: 'needs-local', b: 'needs-local', c: 'pending', d: 'skipped' }, { failedStepId: 'a' })
    const end = { ok: false, failedNodeId: 'a', localNodeIds: ['a', 'b'] }
    expect(localSteps(end, run)).toEqual(['a', 'b', 'c', 'd'])
    expect(remotePassed(end, run)).toBe(true)
  })

  it('reads the RunResult when the stream has no end event', () => {
    const run = result({ s: 'passed', a: 'needs-local', c: 'pending' })
    expect(localSteps(undefined, run)).toEqual(['a', 'c'])
    expect(remotePassed(undefined, run)).toBe(true)
  })
})

describe('exit code', () => {
  it('a real remote failure runs nothing locally and exits non-zero', () => {
    const run = result({ s: 'failed', t: 'skipped' }, { failedStepId: 's' })
    const end = { ok: false, failedNodeId: 's' }
    expect(localSteps(end, run)).toEqual([])
    expect(exitCode(remotePassed(end, run), [])).toBe(1)
  })

  it('a failed local step after the fallback exits non-zero', () => {
    expect(exitCode(true, [true, false])).toBe(1)
    expect(exitCode(true, [true, true])).toBe(0)
  })

  it('an old server run behaves as before', () => {
    const run = result({ s: 'passed' }, { status: 'passed' })
    expect(localSteps({ ok: true }, run)).toEqual([])
    expect(exitCode(remotePassed({ ok: true }, run), [])).toBe(0)
  })
})
