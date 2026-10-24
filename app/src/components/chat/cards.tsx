import { useState } from 'react'
import type { AiProvider } from '@shared/types'
import { aiSelectionLabel } from '@shared/ai'
import type { AgentMessage } from '../../types'
import { C, MONO, ELLIPSIS } from '../../theme'
import { stripControlMarkers } from '../../markdown'
import { Button } from '../controls'
import {
  CheckIcon,
  Spinner,
  StatusMark,
  ToolIcon
} from '../icons'

function ChatCard({
  title,
  extra,
  children,
  compact,
  style
}: {
  title: React.ReactNode
  extra?: React.ReactNode
  children?: React.ReactNode
  compact?: boolean
  style?: React.CSSProperties
}) {
  return (
    <div
      style={{
        border: `1px solid ${C.hair}`,
        borderRadius: 10,
        overflow: 'hidden',
        background: 'oklch(0.21 0.005 95)',
        ...style
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: compact ? 9 : 8,
          minWidth: 0,
          padding: compact ? '7px 11px' : '11px 14px',
          borderBottom: children ? `1px solid ${C.hair}` : undefined
        }}
      >
        <ToolIcon />
        <span
          style={{
            fontFamily: MONO,
            fontSize: compact ? 11.5 : 12,
            color: C.textRow,
            flex: compact ? 'none' : undefined
          }}
        >
          {title}
        </span>
        {extra}
      </div>
      {children}
    </div>
  )
}

export function ChatBanner({
  children,
  role,
  labelledBy,
  describedBy,
  style
}: {
  children: React.ReactNode
  role?: 'alertdialog' | 'status'
  labelledBy?: string
  describedBy?: string
  style?: React.CSSProperties
}) {
  return (
    <div
      role={role}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      style={{
        flex: 'none',
        margin: '12px 34px 0',
        maxWidth: 700,
        marginLeft: 'auto',
        marginRight: 'auto',
        width: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 14px',
        background: 'oklch(0.21 0.005 95)',
        border: `1px solid ${C.hair}`,
        borderRadius: 10,
        ...style
      }}
    >
      {children}
    </div>
  )
}

/**
 * One tool call, live. These arrive in bursts while the agent works, so the
 * card is a single quiet line — the point is to show that something is
 * happening and what it is touching, not to reproduce a terminal.
 */
export function ToolCard({ tool, tight }: { tool: NonNullable<AgentMessage['tool']>; tight: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '6px 12px',
        marginTop: tight ? -16 : 0,
        borderRadius: 8,
        background: C.rail,
        border: '1px solid oklch(1 0 0 / 0.05)',
        minWidth: 0
      }}
    >
      {tool.state === 'running' ? (
        <Spinner size={10} />
      ) : (
        <span
          aria-hidden
          style={{ width: 6, height: 6, flex: 'none', borderRadius: '50%', background: tool.state === 'done' ? C.green : C.red }}
        />
      )}
      <span style={{ flex: 'none', fontFamily: MONO, fontSize: 11.5, color: C.textRow }}>{tool.name}</span>
      {tool.detail && (
        <span
          title={tool.detail}
          style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11, color: C.faint, ...ELLIPSIS, userSelect: 'text' }}
        >
          {tool.detail}
        </span>
      )}
    </div>
  )
}

export function PipelineMsgCard({
  pc,
  text,
  onOpenPipeline
}: {
  pc: NonNullable<AgentMessage['pipeline']>
  text: string
  onOpenPipeline: (tabId: string) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '6px 0', fontSize: 13 }}>
      <span aria-hidden style={{ width: 16, flex: 'none', alignSelf: 'center', display: 'grid', placeItems: 'center' }}>
        {pc.status === 'running' ? (
          <Spinner size={14} />
        ) : pc.status === 'passed' ? (
          <CheckIcon size={14} color={C.textMuted} strokeWidth={2} />
        ) : (
          <span
            style={{
              width: 14,
              height: 14,
              boxSizing: 'border-box',
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              border: `1.5px solid ${pc.status === 'failed' ? C.red : C.faint}`,
              color: C.red,
              fontSize: 9,
              lineHeight: 1
            }}
          >
            {pc.status === 'failed' ? '✕' : null}
          </span>
        )}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', userSelect: 'text' }}>
        <span style={{ fontWeight: 500, color: C.text }}>{pc.pipelineName}</span>
        <span style={{ marginLeft: 10, color: C.faint, whiteSpace: 'pre-wrap' }}>{text}</span>
      </span>
      <button
        type="button"
        className="bf-focus bf-icon-btn"
        onClick={() => onOpenPipeline(pc.tabId)}
        title="Jump to this run's terminal tab"
        style={{ flex: 'none', fontSize: 12.5, color: C.textMuted, padding: '2px 6px', borderRadius: 6, border: 'none', background: 'transparent', fontFamily: 'inherit', cursor: 'pointer' }}
      >
        Logs
      </button>
    </div>
  )
}

export function AssistantFooter({
  text,
  provider,
  model,
  onNewChat
}: {
  text: string
  provider: AiProvider
  model?: string
  onNewChat: () => void
}) {
  const action: React.CSSProperties = {
    width: 24,
    height: 24,
    display: 'grid',
    placeItems: 'center',
    border: 'none',
    borderRadius: 6,
    background: 'transparent',
    color: 'inherit',
    padding: 0,
    cursor: 'pointer'
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, color: C.faint, fontSize: 11.5 }}>
      <span>{aiSelectionLabel(provider, model)}</span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        className="bf-focus bf-composer-btn"
        title="Clear chat"
        aria-label="Clear chat and start fresh"
        onClick={onNewChat}
        style={action}
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
          <path d="M2 3.5h10M5.5 3.5V2h3v1.5M3.5 3.5l.6 8.5h5.8l.6-8.5" />
        </svg>
      </button>
      <button
        type="button"
        className="bf-focus bf-composer-btn"
        title="Copy"
        aria-label="Copy message"
        onClick={() => void navigator.clipboard?.writeText(stripControlMarkers(text))}
        style={action}
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
          <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" />
          <path d="M9.5 4.5V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v5A1.5 1.5 0 0 0 3 9.5h1.5" />
        </svg>
      </button>
    </div>
  )
}

function QuestionOptionButton({
  option,
  selected,
  locked,
  onSelect
}: {
  option: { label: string; description: string }
  selected: boolean
  locked: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className="bf-focus"
      disabled={locked}
      aria-pressed={selected}
      onClick={onSelect}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 2,
        width: '100%',
        padding: '8px 10px',
        border: selected ? `1px solid ${C.accent}` : `1px solid ${C.border}`,
        borderRadius: 8,
        background: selected ? 'rgba(214, 242, 58,0.12)' : 'transparent',
        color: C.textSoft,
        cursor: locked ? 'default' : 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit'
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600 }}>{option.label}</span>
      {option.description && (
        <span style={{ fontSize: 12, lineHeight: 1.4, color: C.textMuted }}>{option.description}</span>
      )}
    </button>
  )
}

export function QuestionCard({
  card,
  onAnswer
}: {
  card: NonNullable<AgentMessage['question']>
  onAnswer: (requestId: string, answers: string[][] | null) => void
}) {
  const locked = !!card.answers || !!card.dismissed
  const [picks, setPicks] = useState<string[][]>(() =>
    card.questions.map((_, i) => card.answers?.[i] ?? [])
  )
  const [custom, setCustom] = useState<string[]>(() => card.questions.map(() => ''))

  const toggle = (qi: number, label: string): void => {
    if (locked) return
    setPicks((prev) =>
      prev.map((row, i) => {
        if (i !== qi) return row
        if (card.questions[qi].multiple) {
          return row.includes(label) ? row.filter((item) => item !== label) : [...row, label]
        }
        return row[0] === label ? [] : [label]
      })
    )
    if (!card.questions[qi].multiple) {
      setCustom((prev) => prev.map((value, i) => (i === qi ? '' : value)))
    }
  }

  const answers = card.questions.map((question, i) => {
    const typed = custom[i].trim()
    if (question.multiple) return typed ? [...picks[i], typed] : picks[i]
    return typed ? [typed] : picks[i]
  })
  const ready = answers.every((row) => row.length > 0)

  return (
    <ChatCard
      title={
        card.dismissed
          ? 'questions dismissed'
          : `question${card.questions.length === 1 ? '' : 's'}`
      }
      extra={locked && !card.dismissed ? <StatusMark done size={18} /> : null}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '13px 15px' }}>
        {card.questions.map((question, qi) => {
          const selected = new Set(card.answers?.[qi] ?? picks[qi])
          const extras = (card.answers?.[qi] ?? []).filter(
            (label) => !question.options.some((option) => option.label === label)
          )
          return (
            <div key={`${card.requestId}-${qi}`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: C.faint, letterSpacing: '0.02em' }}>
                {question.header}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.45, color: C.textSoft }}>{question.question}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {question.options.map((option) => (
                  <QuestionOptionButton
                    key={option.label}
                    option={option}
                    selected={selected.has(option.label)}
                    locked={locked}
                    onSelect={() => toggle(qi, option.label)}
                  />
                ))}
              </div>
              {question.custom !== false && !locked && (
                <input
                  className="bf-focus"
                  value={custom[qi]}
                  onChange={(e) => {
                    const value = e.target.value
                    setCustom((prev) => prev.map((item, i) => (i === qi ? value : item)))
                    if (!question.multiple) {
                      setPicks((prev) => prev.map((row, i) => (i === qi ? [] : row)))
                    }
                  }}
                  placeholder="Type your own answer"
                  aria-label={`Custom answer for ${question.header}`}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    border: `1px solid ${C.border}`,
                    borderRadius: 8,
                    background: C.terminal,
                    color: C.text,
                    fontSize: 12,
                    padding: '7px 10px',
                    outline: 'none',
                    fontFamily: 'inherit'
                  }}
                />
              )}
              {locked && extras.length > 0 && (
                <div style={{ fontSize: 12, color: C.textMuted }}>{extras.join(', ')}</div>
              )}
            </div>
          )
        })}
        {!locked && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={() => onAnswer(card.requestId, null)}>Skip</Button>
            <Button
              variant="primary"
              disabled={!ready}
              onClick={() => onAnswer(card.requestId, answers)}
            >
              Continue
            </Button>
          </div>
        )}
      </div>
    </ChatCard>
  )
}
