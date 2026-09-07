import { describe, expect, it } from 'vitest'
import type { AgentTaskEvent, PipelineNode } from '@shared/types'
import { bindLatestRunId, bindRunStart, isLiveBoundRun, runOutcomeLabel, syncAgentPipelineRun } from './run-slot'
import type { RunState, RunsByBranch } from './types'

const nodes: PipelineNode[] = [
  { id: 'n1', name: 'Lint', type: 'shell', cmd: 'echo', after: [], x: 0, y: 0 }
]

function run(partial: Partial<RunState> & Pick<RunState, 'runId' | 'status'>): RunState {
  return {
    label: partial.label ?? 'Running…',
    startedAt: partial.startedAt ?? 1,
    stepResults: partial.stepResults ?? { n1: 'pending' },
    ...partial
  }
}

function slot(cur: RunState): RunsByBranch {
  return { lint: { main: cur } }
}

function pipelineEvent(
  status: Extract<AgentTaskEvent, { kind: 'pipeline' }>['status'],
  runId?: string
): Extract<AgentTaskEvent, { kind: 'pipeline' }> {
  return {
    kind: 'pipeline',
    taskId: 't1',
    pipelineId: 'lint',
    pipelineName: 'Lint',
    status,
    startedAt: 10,
    ...(runId ? { runId } : {})
  }
}

describe('bindRunStart', () => {
  it('fills an empty or pending slot', () => {
    expect(bindRunStart({}, 'lint', 'main', { runId: 'r1', startedAt: 5 }, nodes).lint.main).toMatchObject({
      runId: 'r1',
      status: 'running',
      label: 'Running…'
    })
    const pending = slot(run({ runId: 'pending:1', status: 'running' }))
    expect(bindRunStart(pending, 'lint', 'main', { runId: 'r1', startedAt: 5 }, nodes).lint.main.runId).toBe('r1')
  })

  it('keeps an already-live runner id so a late start cannot steal the slot', () => {
    const live = slot(run({ runId: 'r-live', status: 'running', label: 'Running…', startedAt: 1 }))
    expect(bindRunStart(live, 'lint', 'main', { runId: 'r-late', startedAt: 9 }, nodes)).toBe(live)
    expect(bindRunStart(live, 'lint', 'main', { runId: 'r-live', startedAt: 1 }, nodes)).toBe(live)
  })
})

describe('bindLatestRunId', () => {
  it('replaces empty or placeholder ids and keeps a live runner id', () => {
    expect(bindLatestRunId(undefined, 'r1')).toBe('r1')
    expect(bindLatestRunId('pending:1', 'r1')).toBe('r1')
    expect(bindLatestRunId('r-live', 'r-late')).toBe('r-live')
    expect(bindLatestRunId('r-live', 'r-live')).toBe('r-live')
  })
})

describe('isLiveBoundRun', () => {
  it('treats pending and agent ids as placeholders', () => {
    expect(isLiveBoundRun(run({ runId: 'abc', status: 'running' }))).toBe(true)
    expect(isLiveBoundRun(run({ runId: 'pending:1', status: 'running' }))).toBe(false)
    expect(isLiveBoundRun(run({ runId: 'agent:1', status: 'running' }))).toBe(false)
    expect(isLiveBoundRun(run({ runId: 'abc', status: 'pass' }))).toBe(false)
  })
})

describe('runOutcomeLabel', () => {
  it('uses one sentence for runner, cancel, and agent outcomes', () => {
    expect(runOutcomeLabel('cancelled', 'main', '12:00')).toBe('Cancelled on main · 12:00')
    expect(runOutcomeLabel('pass', 'main', '12:00')).toBe('Passed on main · 12:00')
    expect(runOutcomeLabel('passed', 'dev', '1:02')).toBe('Passed on dev · 1:02')
    expect(runOutcomeLabel('fail', 'main', '12:00')).toBe('Failed on main · 12:00')
    expect(runOutcomeLabel('failed', 'main', '12:00')).toBe('Failed on main · 12:00')
  })
})

describe('syncAgentPipelineRun', () => {
  it('ignores running cards and live runner slots', () => {
    const prev = slot(run({ runId: 'r-live', status: 'running' }))
    expect(syncAgentPipelineRun(prev, pipelineEvent('running', 'r1'), 'lint', 'main', nodes, '12:00')).toBe(prev)
    expect(syncAgentPipelineRun(prev, pipelineEvent('failed', 'error:1'), 'lint', 'main', nodes, '12:00')).toBe(prev)
  })

  it('records a start-failed agent run when the slot is free', () => {
    const next = syncAgentPipelineRun({}, pipelineEvent('failed', 'error:1'), 'lint', 'main', nodes, '12:00')
    expect(next.lint.main).toMatchObject({
      runId: 'error:1',
      status: 'fail',
      label: 'Failed on main · 12:00'
    })
  })
})
