import { AI_LABELS } from '@shared/ai'
import type { AgentTaskEvent } from '@shared/types'
import type { AgentApprovalCard, AgentMessage } from './types'
import { upsertMessage } from './pipeline-chat'

const DECIDED: Record<NonNullable<AgentApprovalCard['decision']>, string> = {
  once: 'Allowed once',
  chat: 'Allowed for this chat',
  deny: 'Declined',
  expired: 'No longer waiting'
}

function approvalText(card: AgentApprovalCard): string {
  const who = `${AI_LABELS[card.provider]}${card.delegateId ? ' subagent' : ''}`
  const what = `${card.toolName}${card.detail ? ` — ${card.detail}` : ''}`
  return card.decision ? `${DECIDED[card.decision]}: ${what}` : `${who} asks to run ${what}`
}

/** An approval request opening, or closing in place once answered. */
export function applyApprovalEvent(
  messages: AgentMessage[],
  event: Extract<AgentTaskEvent, { kind: 'approval' }>
): AgentMessage[] {
  const card: AgentApprovalCard = {
    requestId: event.requestId,
    provider: event.provider,
    ...(event.delegateId ? { delegateId: event.delegateId } : {}),
    toolName: event.toolName,
    ...(event.detail ? { detail: event.detail } : {}),
    ...(event.decision ? { decision: event.decision } : {})
  }
  return upsertMessage(
    messages,
    (item) => item.approval?.requestId === event.requestId,
    { role: 'system', text: approvalText(card), approval: card }
  )
}

/** The transcript line for turning auto-approve on or off mid-chat. */
export function autoApproveNotice(on: boolean): AgentMessage {
  return {
    role: 'system',
    text: on
      ? 'Auto-approve on: tools run without asking, from the next turn.'
      : 'Auto-approve off: Claude asks in Chat before running tools, from the next turn.'
  }
}
