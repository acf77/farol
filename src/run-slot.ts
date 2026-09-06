import type { AgentTaskEvent, PipelineNode, StepState } from '@shared/types'
import type { RunState, RunsByBranch } from './types'

function isPlaceholderRunId(runId: string | undefined): boolean {
  return !!runId && (runId.startsWith('pending:') || runId.startsWith('agent:'))
}

/** Sidebar sentence shared by runner end, cancel, and agent fallback. */
export function runOutcomeLabel(
  status: RunState['status'] | Extract<AgentTaskEvent, { kind: 'pipeline' }>['status'],
  branch: string,
  time: string
): string {
  const title = status === 'cancelled' ? 'Cancelled'
    : status === 'pass' || status === 'passed' ? 'Passed'
    : 'Failed'
  return `${title} on ${branch} · ${time}`
}

/** A real runner id already owns this branch slot — do not steal its events. */
export function isLiveBoundRun(cur: RunState | undefined): boolean {
  return cur?.status === 'running' && !!cur.runId && !isPlaceholderRunId(cur.runId)
}

/** Keep the live run id so a late `start` cannot drop its remaining events. */
export function bindLatestRunId(bound: string | undefined, incoming: string): string {
  if (!bound || bound === incoming || isPlaceholderRunId(bound)) return incoming
  return bound
}

function writeSlot(
  prev: RunsByBranch,
  pipelineId: string,
  branch: string,
  run: RunState
): RunsByBranch {
  return {
    ...prev,
    [pipelineId]: {
      ...prev[pipelineId],
      [branch]: run
    }
  }
}

function pendingSteps(nodes: PipelineNode[]): Record<string, StepState> {
  return Object.fromEntries(nodes.map((n) => [n.id, 'pending' as StepState]))
}

/** Bind a runner `start` onto the branch slot, ignoring overlapping live runs. */
export function bindRunStart(
  prev: RunsByBranch,
  pipelineId: string,
  branch: string,
  event: { runId: string; startedAt: number },
  nodes: PipelineNode[]
): RunsByBranch {
  const cur = prev[pipelineId]?.[branch]
  if (cur?.runId === event.runId || isLiveBoundRun(cur)) return prev
  return writeSlot(prev, pipelineId, branch, {
    runId: event.runId,
    status: 'running',
    label: 'Running…',
    startedAt: event.startedAt,
    stepResults: pendingSteps(nodes)
  })
}

function agentRunStatus(
  status: Extract<AgentTaskEvent, { kind: 'pipeline' }>['status']
): RunState['status'] {
  if (status === 'cancelled') return 'cancelled'
  if (status === 'passed') return 'pass'
  return 'fail'
}

/**
 * Fallback when managed Chat reports a terminal pipeline state but the RunEvent
 * stream never bound the slot (e.g. the runner threw before `start`).
 */
export function syncAgentPipelineRun(
  prev: RunsByBranch,
  event: Extract<AgentTaskEvent, { kind: 'pipeline' }>,
  pipelineId: string,
  branch: string,
  nodes: PipelineNode[],
  time: string
): RunsByBranch {
  const cur = prev[pipelineId]?.[branch]
  if (event.status === 'running' || isLiveBoundRun(cur)) return prev
  if (cur && event.runId && cur.runId === event.runId && cur.status !== 'running') return prev
  return writeSlot(prev, pipelineId, branch, {
    runId: event.runId ?? cur?.runId ?? `agent:${event.startedAt}`,
    status: agentRunStatus(event.status),
    label: runOutcomeLabel(event.status, branch, time),
    startedAt: event.startedAt,
    stepResults: cur?.stepResults ?? pendingSteps(nodes)
  })
}
