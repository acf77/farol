import type { RunEvent } from '@shared/types'
import type { AgentMessage, AgentPipelineCard, Tab } from './types'
import { trimAgentMessages } from './chat-context'

function fmtEventTime(epoch: number): string {
  return new Date(epoch).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, '0')}s`
}

/** Same body text whether the run was started from Chat or the sidebar. */
export function pipelineActivityText(
  card: Pick<AgentPipelineCard, 'status' | 'startedAt' | 'finishedAt' | 'durationMs'>
): string {
  if (card.status === 'running') return `$ pipeline run — started ${fmtEventTime(card.startedAt)}`
  return `${card.status} — ${fmtEventTime(card.finishedAt ?? card.startedAt)}${
    card.durationMs === undefined ? '' : ` · ${fmtDuration(card.durationMs)}`
  }`
}

function runCardStatus(
  event: Extract<RunEvent, { kind: 'start' | 'end' }>
): AgentPipelineCard['status'] {
  if (event.kind === 'start') return 'running'
  if (event.cancelled) return 'cancelled'
  return event.ok ? 'passed' : 'failed'
}

function upsertRunMessage(
  pane: Tab['panes'][string],
  event: Extract<RunEvent, { kind: 'start' | 'end' }>,
  pipelineId: string,
  pipelineName: string
): Tab['panes'][string] | null {
  if (pane.kind !== 'agent') return null
  const index = pane.messages.findIndex((message) => message.pipeline?.runId === event.runId)
  const previous = pane.messages[index]?.pipeline
  if (event.kind === 'start' && previous) return null
  if (event.kind === 'end' && !previous) return null
  const finishedAt = event.kind === 'end' ? Date.now() : undefined
  const startedAt = event.kind === 'start' ? event.startedAt : previous!.startedAt
  const pipeline: AgentPipelineCard = {
    runId: event.runId,
    pipelineId,
    pipelineName,
    status: runCardStatus(event),
    startedAt,
    finishedAt,
    durationMs: finishedAt === undefined ? undefined : finishedAt - startedAt,
    tabId: `run:${pipelineId}:${event.branch}`
  }
  const message: AgentMessage = {
    role: 'system',
    text: pipelineActivityText(pipeline),
    pipeline
  }
  const messages = [...pane.messages]
  if (index < 0) messages.push(message)
  else messages[index] = message
  return { ...pane, messages: trimAgentMessages(messages) }
}

/** Project the runner lifecycle into existing chats on its branch. Never creates chats. */
export function projectRunChat(
  tabs: Tab[],
  event: Extract<RunEvent, { kind: 'start' | 'end' }>,
  pipelineId: string,
  pipelineName: string
): Tab[] {
  return tabs.map((tab) => {
    if (tab.kind !== 'agent') return tab
    if (event.kind === 'start' && tab.branch !== event.branch) return tab
    let panes = tab.panes
    for (const pane of Object.values(tab.panes)) {
      const next = upsertRunMessage(pane, event, pipelineId, pipelineName)
      if (next) panes = { ...panes, [pane.id]: next }
    }
    return panes === tab.panes ? tab : { ...tab, panes }
  })
}
