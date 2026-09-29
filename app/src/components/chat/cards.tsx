import { useState } from 'react'
import type { AiProvider } from '@shared/types'
import { AI_LABELS } from '@shared/ai'
import type { AgentMessage } from '../../types'
import { C, MONO, ELLIPSIS } from '../../theme'
import { stripControlMarkers } from '../../markdown'
import { Button } from '../controls'
import {
  CircleIcon,
  ClearChatIcon,
  CopyIcon,
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
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        overflow: 'hidden',
        background: C.sidebar,
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
          borderBottom: children ? `1px solid ${C.border}` : undefined
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
        maxWidth: 680,
        marginLeft: 'auto',
        marginRight: 'auto',
        width: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 14px',
        background: C.sidebar,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
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
    <ChatCard
      compact
      style={{ marginTop: tight ? -16 : 0 }}
      title={tool.name}
      extra={
        <>
          {tool.detail && (
            <span
              title={tool.detail}
              style={{
                fontFamily: MONO,
                fontSize: 11,
                color: C.textMuted,
                minWidth: 0,
                ...ELLIPSIS,
                userSelect: 'text'
              }}
            >
              {tool.detail}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {tool.state === 'running' ? (
            <Spinner />
          ) : tool.state === 'done' ? (
            <StatusMark done size={18} />
          ) : (
            <span style={{ fontSize: 12, fontWeight: 700, color: C.red }}>✗</span>
          )}
        </>
      }
    />
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
    <ChatCard
      title={`pipeline: ${pc.pipelineName}`}
      extra={
        <>
          {pc.status === 'running' ? (
            <Spinner />
          ) : pc.status === 'passed' ? (
            <StatusMark done size={18} />
          ) : (
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: pc.status === 'failed' ? C.red : C.faint
              }}
            >
              {pc.status === 'failed' ? '✗' : '–'}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="bf-focus bf-linkish"
            onClick={() => onOpenPipeline(pc.tabId)}
            style={{
              fontSize: 11,
              color: C.textMuted,
              cursor: 'pointer',
              border: 'none',
              background: 'transparent',
              padding: 0,
              fontFamily: 'inherit'
            }}
            title="Jump to this run's terminal tab"
          >
            Open in terminal
          </button>
        </>
      }
    >
      <div
        style={{
          padding: '13px 15px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          fontFamily: MONO,
          fontSize: 12,
          lineHeight: 1.5,
          color: C.textMuted,
          userSelect: 'text'
        }}
      >
        {text}
      </div>
    </ChatCard>
  )
}

export function AssistantFooter({
  text,
  provider,
  onNewChat
}: {
  text: string
  provider: AiProvider
  onNewChat: () => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.textMuted }}>
      <CircleIcon />
      <span style={{ fontSize: 12 }}>{AI_LABELS[provider]}</span>
      <span style={{ flex: 1 }} />
      <div style={{ display: 'flex', gap: 16 }}>
        <button
          type="button"
          className="bf-focus bf-composer-btn"
          title="Copy"
          aria-label="Copy message"
          onClick={() => void navigator.clipboard?.writeText(stripControlMarkers(text))}
          style={{
            display: 'grid',
            placeItems: 'center',
            border: 'none',
            background: 'transparent',
            color: 'inherit',
            padding: 0,
            cursor: 'pointer'
          }}
        >
          <CopyIcon />
        </button>
        <button
          type="button"
          className="bf-focus bf-composer-btn"
          title="Clear chat and start fresh"
          aria-label="Clear chat and start fresh"
          onClick={onNewChat}
          style={{
            display: 'grid',
            placeItems: 'center',
            border: 'none',
            background: 'transparent',
            color: 'inherit',
            padding: 0,
            cursor: 'pointer'
          }}
        >
          <ClearChatIcon size={15} />
        </button>
      </div>
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
