import { aiSelectionLabel } from '@shared/ai'
import type { AgentTaskEvent } from '@shared/types'
import type { AgentDelegateCard, AgentMessage } from './types'
import { upsertMessage } from './pipeline-chat'

/** Enough of a subagent's activity to see what it is doing, without keeping its whole transcript. */
const MAX_TOOLS = 50
const MAX_SAID = 4000

type DelegateEvent = Extract<AgentTaskEvent, { kind: 'delegate' }>
type DelegateActivity = Extract<AgentTaskEvent, { kind: 'output' | 'assistant' | 'tool' }> & { delegateId: string }

/** True for a subagent's own output, tool or turn, which belongs on its card. */
export function isDelegateActivity(event: AgentTaskEvent): event is DelegateActivity {
  return (event.kind === 'output' || event.kind === 'assistant' || event.kind === 'tool') && !!event.delegateId
}

function delegateText(card: AgentDelegateCard): string {
  const label = aiSelectionLabel(card.provider, card.model)
  const head =
    card.state === 'running'
      ? `${label} subagent working`
      : card.state === 'done'
        ? `${label} subagent finished`
        : `${label} subagent failed`
  const undone = card.undone === 'restore' ? 'Checkout restored to before it ran.' : card.undone ? 'Its changes were undone.' : ''
  return [`${head}: ${card.task}`, card.diffStat, undone].filter(Boolean).join('\n')
}

function message(card: AgentDelegateCard): AgentMessage {
  return { role: 'system', text: delegateText(card), delegate: card }
}

const sameRun = (id: string) => (item: AgentMessage) => item.delegate?.delegateId === id

/** A subagent's run starting or ending. */
export function applyDelegateEvent(messages: AgentMessage[], event: DelegateEvent): AgentMessage[] {
  const existing = messages.find(sameRun(event.delegateId))?.delegate
  const card: AgentDelegateCard = {
    tools: existing?.tools ?? [],
    said: existing?.said ?? '',
    delegateId: event.delegateId,
    provider: event.provider,
    ...(event.model ? { model: event.model } : {}),
    task: event.task,
    state: event.state,
    ...(event.diffStat ? { diffStat: event.diffStat } : {}),
    ...(event.message ? { message: event.message } : {}),
    ...(event.undoable ? { undoable: true } : {}),
    ...(event.undone ? { undone: event.undone } : {})
  }
  return upsertMessage(messages, sameRun(event.delegateId), message(card))
}

/** Fold a subagent's output, turn or tool call into its card; dropped if the card is gone. */
export function applyDelegateActivity(messages: AgentMessage[], event: DelegateActivity): AgentMessage[] {
  const existing = messages.find(sameRun(event.delegateId))?.delegate
  if (!existing) return messages
  let { tools, said } = existing
  if (event.kind === 'output') said = (said + event.chunk).slice(-MAX_SAID)
  else if (event.kind === 'assistant') said = event.text.slice(-MAX_SAID)
  else {
    const prior = tools.find((t) => t.toolId === event.toolId)
    const tool = {
      toolId: event.toolId,
      name: event.name || prior?.name || 'tool',
      ...((event.detail ?? prior?.detail) ? { detail: event.detail ?? prior?.detail } : {}),
      ...((event.auto ?? prior?.auto) ? { auto: true } : {}),
      state: event.state
    }
    tools = prior
      ? tools.map((t) => (t.toolId === event.toolId ? tool : t))
      : [...tools, tool].slice(-MAX_TOOLS)
  }
  return upsertMessage(messages, sameRun(event.delegateId), message({ ...existing, tools, said }))
}
