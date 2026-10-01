import type { AiProvider } from '@shared/types'
import type { AgentMessage } from '../../types'
import { C } from '../../theme'
import { MarkdownBody } from '../../markdown'
import { Button } from '../controls'
import { AssistantFooter, PipelineMsgCard, QuestionCard, ToolCard } from './cards'

function fmtClock(epoch: number): string {
  const d = new Date(epoch)
  const h = d.getHours() % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`
}

export function Turn({
  m,
  i,
  messages,
  isBusy,
  provider,
  model,
  onOpenPipeline,
  onNewChat,
  onAnswer,
  canExecutePlan,
  onExecutePlan
}: {
  m: AgentMessage
  i: number
  messages: AgentMessage[]
  isBusy: boolean
  provider: AiProvider
  model?: string
  onOpenPipeline: (tabId: string) => void
  onNewChat: () => void
  onAnswer: (requestId: string, answers: string[][] | null) => void
  canExecutePlan: boolean
  onExecutePlan: (index: number) => void
}) {
  if (m.role === 'user') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        <div
          style={{
            maxWidth: 440,
            padding: '10px 14px',
            background: 'oklch(0.26 0.005 95)',
            borderRadius: '14px 14px 4px 14px',
            fontSize: 13.5,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            userSelect: 'text'
          }}
        >
          {m.text}
        </div>
        {m.at && (
          <span style={{ fontSize: 11, color: C.fainter }}>{fmtClock(m.at)}</span>
        )}
      </div>
    )
  }

  if (m.question) return <QuestionCard card={m.question} onAnswer={onAnswer} />
  if (m.tool) return <ToolCard tool={m.tool} tight={!!messages[i - 1]?.tool} />

  const pc = m.pipeline
  // The footer closes an answer: the last plain reply, once nothing newer has been said.
  const plain = (x: AgentMessage): boolean => x.role === 'assistant' && !x.tool && !x.question && !x.pipeline
  const showFooter = plain(m) && !isBusy && !messages.slice(i + 1).some((x) => x.role === 'user' || plain(x))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {pc ? (
        <PipelineMsgCard pc={pc} text={m.text} onOpenPipeline={onOpenPipeline} />
      ) : m.role === 'assistant' ? (
        <MarkdownBody text={m.text} />
      ) : (
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.6,
            color: C.textMuted,
            textWrap: 'pretty',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            userSelect: 'text'
          }}
        >
          {m.text}
        </div>
      )}

      {canExecutePlan && <ExecutePlanButton onExecute={() => onExecutePlan(i)} />}
      {showFooter && <AssistantFooter text={m.text} provider={provider} model={model} onNewChat={onNewChat} />}
    </div>
  )
}

function ExecutePlanButton({ onExecute }: { onExecute: () => void }) {
  return (
    <Button variant="primary" onClick={onExecute} style={{ alignSelf: 'flex-start', marginTop: 12 }}>
      Execute plan
    </Button>
  )
}
