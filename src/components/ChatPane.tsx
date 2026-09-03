import { useEffect, useRef, useState } from 'react'
import type { AgentSkill, AiProvider, Pipeline } from '@shared/types'
import { AI_LABELS, aiSelectionLabel, normalizeAi, normalizeModel } from '@shared/ai'
import {
  convertSkillDraft,
  filterSkills,
  insertSkillText,
  retainSkillWarning,
  skillMenuQuery,
  skillWarningLine
} from '@shared/skills'
import type { AgentMessage, AgentPane, View } from '../types'
import { C, MONO, PANE } from '../theme'
import { MarkdownBody, stripControlMarkers } from '../markdown'
import { MessageErrorBoundary } from '../ErrorBoundary'
import { CliModelMenu } from './controls'
import {
  CheckIcon,
  ChevronDown,
  CircleIcon,
  ClipIcon,
  ClearChatIcon,
  CopyIcon,
  SendIcon,
  Spinner,
  ThumbIcon,
  ToolIcon
} from './icons'
import farolMark from '../assets/farol-mark.png'

interface Props {
  pane: AgentPane | null
  pipelines: Pipeline[]
  view: View
  projectPath: string
  /** Settings default used when no chat pane exists yet. */
  defaultProvider: AiProvider
  /** Last-chosen model for `defaultProvider`. Omitted means the CLI default. */
  defaultModel?: string
  onMessage: (text: string, provider: AiProvider, model?: string) => void
  /** `answers: null` dismisses the chooser. */
  onAnswer: (requestId: string, answers: string[][] | null) => void
  onCancel: () => void
  onProviderChange: (provider: AiProvider, model?: string) => void
  onOpenPipeline: (tabId: string) => void
  onNewChat: () => void
  clearChatConfirm?: boolean
  onConfirmClearChat?: () => void
  onCancelClearChat?: () => void
  /** Shown briefly after the user clears — explains the old chat was removed, not hidden. */
  chatClearedNotice?: boolean
  onDismissChatCleared?: () => void
  /** Focus hook so ⌘K can put the caret in the composer. */
  composerRef?: React.RefObject<HTMLTextAreaElement>
}

interface PendingAttachment {
  name: string
  path: string
  previewUrl: string
}

const busy = new Set(['working', 'validating', 'repairing'])

/** How far off the bottom still counts as "following the stream", in px. */
const STICK_SLACK = 80

const SUGGESTIONS = [
  'Run every available validation pipeline before I open a PR',
  'Walk me through what the selected pipeline checks and why',
  'Investigate why the last run failed and suggest a fix'
]

function greetingFor(date: Date): string {
  const h = date.getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function fmtClock(epoch: number): string {
  const d = new Date(epoch)
  const h = d.getHours() % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`
}

/**
 * One tool call, live. These arrive in bursts while the agent works, so the
 * card is a single quiet line — the point is to show that something is
 * happening and what it is touching, not to reproduce a terminal.
 */
function ToolCard({ tool, tight }: { tool: NonNullable<AgentMessage['tool']>; tight: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        minWidth: 0,
        padding: '7px 11px',
        // Close the transcript's 26px turn gap when cards run back to back.
        marginTop: tight ? -16 : 0,
        background: '#111827',
        border: '1px solid #273449',
        borderRadius: 9
      }}
    >
      <ToolIcon />
      <span style={{ fontFamily: MONO, fontSize: 11.5, color: '#CBD5E1', flex: 'none' }}>
        {tool.name}
      </span>
      {tool.detail && (
        <span
          title={tool.detail}
          style={{
            fontFamily: MONO,
            fontSize: 11.5,
            color: '#94A3B8',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
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
        <CheckIcon />
      ) : (
        <span style={{ fontSize: 12, fontWeight: 700, color: C.red }}>✗</span>
      )}
    </div>
  )
}

function messageText(text: unknown): string {
  return typeof text === 'string' ? text : String(text ?? '')
}

function PipelineMsgCard({
  pc,
  text,
  onOpenPipeline
}: {
  pc: NonNullable<AgentMessage['pipeline']>
  text: string
  onOpenPipeline: (tabId: string) => void
}) {
  return (
    <div
      style={{
        border: '1px solid #273449',
        borderRadius: 11,
        overflow: 'hidden',
        background: '#111827'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '11px 14px',
          borderBottom: '1px solid #273449'
        }}
      >
        <ToolIcon />
        <span style={{ fontFamily: MONO, fontSize: 12, color: '#CBD5E1' }}>
          pipeline: {pc.pipelineName}
        </span>
        {pc.status === 'running' ? (
          <Spinner />
        ) : pc.status === 'passed' ? (
          <CheckIcon />
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
        <span
          className="bf-linkish"
          onClick={() => onOpenPipeline(pc.tabId)}
          style={{ fontSize: 11.5, color: '#94A3B8', cursor: 'pointer' }}
          title="Jump to this run's terminal tab"
        >
          Open in terminal
        </span>
      </div>
      <div
        style={{
          padding: '13px 15px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          fontFamily: MONO,
          fontSize: 12,
          lineHeight: 1.5,
          color: '#94A3B8',
          userSelect: 'text'
        }}
      >
        {text}
      </div>
    </div>
  )
}

function AssistantFooter({
  text,
  provider,
  onNewChat
}: {
  text: string
  provider: AiProvider
  onNewChat: () => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#94A3B8' }}>
      <CircleIcon />
      <span style={{ fontSize: 12 }}>{AI_LABELS[provider]}</span>
      <span style={{ flex: 1 }} />
      <div style={{ display: 'flex', gap: 16 }}>
        <span title="Copy" onClick={() => void navigator.clipboard?.writeText(stripControlMarkers(text))}>
          <CopyIcon />
        </span>
        <span title="Good response">
          <ThumbIcon />
        </span>
        <span title="Clear chat and start fresh" onClick={onNewChat}>
          <ClearChatIcon size={15} />
        </span>
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
        border: selected ? '1px solid #2563EB' : '1px solid #273449',
        borderRadius: 8,
        background: selected ? 'rgba(37,99,235,0.12)' : 'transparent',
        color: '#E2E8F0',
        cursor: locked ? 'default' : 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit'
      }}
    >
      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{option.label}</span>
      {option.description && (
        <span style={{ fontSize: 12, lineHeight: 1.4, color: '#94A3B8' }}>{option.description}</span>
      )}
    </button>
  )
}

function QuestionCard({
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
    <div
      style={{
        border: '1px solid #273449',
        borderRadius: 11,
        overflow: 'hidden',
        background: '#111827'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '11px 14px',
          borderBottom: '1px solid #273449'
        }}
      >
        <ToolIcon />
        <span style={{ fontFamily: MONO, fontSize: 12, color: '#CBD5E1' }}>
          {card.dismissed
            ? 'questions dismissed'
            : `question${card.questions.length === 1 ? '' : 's'}`}
        </span>
        {locked && !card.dismissed ? <CheckIcon /> : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '13px 15px' }}>
        {card.questions.map((question, qi) => {
          const selected = new Set(card.answers?.[qi] ?? picks[qi])
          const extras = (card.answers?.[qi] ?? []).filter(
            (label) => !question.options.some((option) => option.label === label)
          )
          return (
            <div key={`${card.requestId}-${qi}`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#64748B', letterSpacing: '0.02em' }}>
                {question.header}
              </div>
              <div style={{ fontSize: 13.5, lineHeight: 1.45, color: '#E2E8F0' }}>{question.question}</div>
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
                    border: '1px solid #273449',
                    borderRadius: 8,
                    background: '#080D17',
                    color: '#F8FAFC',
                    fontSize: 12.5,
                    padding: '7px 10px',
                    outline: 'none',
                    fontFamily: 'inherit'
                  }}
                />
              )}
              {locked && extras.length > 0 && (
                <div style={{ fontSize: 12, color: '#94A3B8' }}>{extras.join(', ')}</div>
              )}
            </div>
          )
        })}
        {!locked && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              className="bf-focus"
              onClick={() => onAnswer(card.requestId, null)}
              style={{
                border: '1px solid #273449',
                background: 'transparent',
                color: '#94A3B8',
                borderRadius: 8,
                padding: '6px 12px',
                fontSize: 12.5,
                cursor: 'pointer'
              }}
            >
              Skip
            </button>
            <button
              type="button"
              className="bf-focus"
              disabled={!ready}
              onClick={() => onAnswer(card.requestId, answers)}
              style={{
                border: 'none',
                background: ready ? C.accent : '#1F2937',
                color: ready ? '#fff' : '#64748B',
                borderRadius: 8,
                padding: '6px 12px',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: ready ? 'pointer' : 'default'
              }}
            >
              Continue
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function Turn({
  m,
  i,
  messages,
  isBusy,
  provider,
  onOpenPipeline,
  onNewChat,
  onAnswer
}: {
  m: AgentMessage
  i: number
  messages: AgentMessage[]
  isBusy: boolean
  provider: AiProvider
  onOpenPipeline: (tabId: string) => void
  onNewChat: () => void
  onAnswer: (requestId: string, answers: string[][] | null) => void
}) {
  if (m.role === 'user') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 7 }}>
        <div
          style={{
            maxWidth: 430,
            padding: '11px 15px',
            background: '#1F2937',
            border: '1px solid #273449',
            borderRadius: 12,
            fontSize: 13.5,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            userSelect: 'text'
          }}
        >
          {messageText(m.text)}
        </div>
        {m.at && (
          <span style={{ fontSize: 11, color: '#64748B' }}>{fmtClock(m.at)}</span>
        )}
      </div>
    )
  }

  if (m.question) return <QuestionCard card={m.question} onAnswer={onAnswer} />
  if (m.tool) return <ToolCard tool={m.tool} tight={!!messages[i - 1]?.tool} />

  const pc = m.pipeline
  const text = messageText(m.text)
  const showFooter = m.role === 'assistant' && i === messages.length - 1 && !isBusy

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 15, minWidth: 0 }}>
      {pc ? (
        <PipelineMsgCard pc={pc} text={text} onOpenPipeline={onOpenPipeline} />
      ) : m.role === 'assistant' ? (
        <MarkdownBody text={text} />
      ) : (
        <div
          style={{
            fontSize: 13.5,
            lineHeight: 1.6,
            color: '#94A3B8',
            textWrap: 'pretty',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            userSelect: 'text'
          }}
        >
          {text}
        </div>
      )}

      {showFooter && <AssistantFooter text={text} provider={provider} onNewChat={onNewChat} />}
    </div>
  )
}

function ClearChatBanner({
  onCancelClearChat,
  onConfirmClearChat
}: {
  onCancelClearChat?: () => void
  onConfirmClearChat?: () => void
}) {
  return (
    <div
      role="alertdialog"
      aria-labelledby="clear-chat-title"
      aria-describedby="clear-chat-desc"
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
        flexWrap: 'wrap',
        gap: '10px 14px',
        padding: '12px 14px',
        background: '#111827',
        border: '1px solid #273449',
        borderRadius: 11
      }}
    >
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div id="clear-chat-title" style={{ fontSize: 13.5, fontWeight: 600, color: C.textSoft }}>
          Clear this conversation?
        </div>
        <div id="clear-chat-desc" style={{ fontSize: 12.5, lineHeight: 1.45, color: C.textMuted, marginTop: 4 }}>
          This branch keeps one chat at a time. Clearing permanently deletes the current messages
          and shows a blank composer — it does not hide the old chat or open a second one.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
        <button
          type="button"
          className="bf-focus"
          onClick={onCancelClearChat}
          style={{
            border: '1px solid #273449',
            background: 'transparent',
            color: C.textMuted,
            borderRadius: 8,
            padding: '6px 12px',
            fontSize: 12.5,
            cursor: 'pointer'
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="bf-focus"
          onClick={onConfirmClearChat}
          style={{
            border: 'none',
            background: 'rgba(239,68,68,0.16)',
            color: C.red,
            borderRadius: 8,
            padding: '6px 12px',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          Clear chat
        </button>
      </div>
    </div>
  )
}

function ChatClearedBanner({ onDismissChatCleared }: { onDismissChatCleared?: () => void }) {
  return (
    <div
      role="status"
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
        padding: '10px 14px',
        background: '#111827',
        border: '1px solid #273449',
        borderRadius: 10
      }}
    >
      <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.45, color: C.textMuted }}>
        Conversation cleared. Previous messages were removed from this branch — switch to another
        branch in the sidebar to see its chat.
      </span>
      <button
        type="button"
        className="bf-focus"
        onClick={onDismissChatCleared}
        aria-label="Dismiss"
        style={{
          flex: 'none',
          border: 'none',
          background: 'transparent',
          color: C.textMuted,
          fontSize: 16,
          lineHeight: 1,
          cursor: 'pointer',
          padding: '2px 4px'
        }}
      >
        ×
      </button>
    </div>
  )
}

function ChatGreeting({ availableCount }: { availableCount: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
      <img
        src={farolMark}
        alt=""
        width={40}
        height={40}
        draggable={false}
        style={{ borderRadius: 10, display: 'block' }}
      />
      <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.2px', marginTop: 18 }}>
        {greetingFor(new Date())}
      </div>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 8 }}>
        {availableCount
          ? 'How can I help you build today?'
          : 'Create a validation pipeline to start a chat.'}
      </div>
    </div>
  )
}

function SuggestionList({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 2,
        marginTop: 28,
        textAlign: 'left'
      }}
    >
      {SUGGESTIONS.map((prompt) => (
        <button
          key={prompt}
          type="button"
          className="bf-suggest bf-focus"
          onClick={() => onPick(prompt)}
          style={{
            display: 'block',
            width: '100%',
            padding: '8px 10px',
            margin: 0,
            background: 'transparent',
            border: 'none',
            borderRadius: 5,
            cursor: 'pointer',
            textAlign: 'left',
            fontSize: 12.5,
            fontWeight: 400,
            lineHeight: 1.45,
            color: C.textSoft,
            fontFamily: 'inherit'
          }}
        >
          {prompt}
        </button>
      ))}
    </div>
  )
}

function AttachmentStrip({
  attachments,
  onRemove
}: {
  attachments: PendingAttachment[]
  onRemove: (path: string) => void
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
      {attachments.map((attachment) => (
        <div
          key={attachment.path}
          style={{
            position: 'relative',
            width: 56,
            height: 56,
            borderRadius: 8,
            overflow: 'hidden',
            border: '1px solid #273449',
            background: '#080D17'
          }}
        >
          <img
            src={attachment.previewUrl}
            alt={attachment.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
          <button
            type="button"
            className="bf-focus"
            onClick={() => onRemove(attachment.path)}
            title={`Remove ${attachment.name}`}
            aria-label={`Remove ${attachment.name}`}
            style={{
              position: 'absolute',
              top: 3,
              right: 3,
              width: 18,
              height: 18,
              borderRadius: '50%',
              border: 'none',
              background: 'rgba(0,0,0,0.65)',
              color: '#fff',
              fontSize: 12,
              lineHeight: 1,
              cursor: 'pointer',
              display: 'grid',
              placeItems: 'center'
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

function ComposerPickerMenu({
  label,
  menuPos,
  empty,
  items,
  index,
  onHover,
  onPick
}: {
  label: string
  menuPos: { left: number; bottom: number; width: number }
  empty: string
  items: { key: string; label: string }[]
  index: number
  onHover: (i: number) => void
  onPick: (i: number) => void
}) {
  return (
    <div
      role="listbox"
      aria-label={label}
      style={{
        position: 'fixed',
        left: menuPos.left,
        bottom: menuPos.bottom,
        width: menuPos.width,
        zIndex: 70,
        maxHeight: 220,
        overflow: 'auto',
        background: '#111827',
        border: `1px solid ${C.cardBorder}`,
        borderRadius: 10,
        boxShadow: '0 14px 36px rgba(0,0,0,0.5)',
        padding: 4
      }}
    >
      {!items.length ? (
        <div style={{ padding: '10px 12px', fontSize: 12, color: C.textMuted }}>{empty}</div>
      ) : (
        items.map((item, i) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={i === index}
            className="bf-focus bf-menu-item"
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(i)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              border: 'none',
              background: i === index ? '#1F2937' : 'transparent',
              color: C.textSoft,
              fontFamily: MONO,
              fontSize: 12,
              cursor: 'pointer'
            }}
          >
            {item.label}
          </button>
        ))
      )}
    </div>
  )
}

function composerPlaceholder(availableCount: number, hasAttachments: boolean): string {
  if (!availableCount) return 'Create a validation pipeline to start'
  if (hasAttachments) return 'Add a message or send the attached images…'
  return 'Message the agent… (drop images here)'
}

type ComposerPicker = {
  count: number
  index: number
  setIndex: React.Dispatch<React.SetStateAction<number>>
  close: () => void
  pick: () => void
}

function pickerHandle<T>(
  items: readonly T[],
  index: number,
  setIndex: React.Dispatch<React.SetStateAction<number>>,
  close: () => void,
  pick: (item: T) => void
): ComposerPicker {
  return {
    count: items.length,
    index,
    setIndex,
    close,
    pick: () => {
      const item = items[index] ?? items[0]
      if (item) pick(item)
    }
  }
}

function mentionFromCaret(value: string, caret: number): { query: string; start: number } | null {
  const prefix = value.slice(0, caret)
  const at = prefix.lastIndexOf('@')
  if (at === -1) return null
  const body = prefix.slice(at + 1)
  if (/\s/.test(body)) return null
  return { query: body, start: at }
}

function composerPickerState(
  value: string,
  caret: number
): { skillQuery: string | null; mention: { query: string; start: number } | null } {
  const skillQuery = skillMenuQuery(value, caret)
  if (skillQuery !== null) return { skillQuery, mention: null }
  return { skillQuery: null, mention: mentionFromCaret(value, caret) }
}

function applyMentionInsert(
  text: string,
  mention: { start: number } | null,
  selectionStart: number | undefined,
  file: string
): { text: string; caret: number | null } {
  if (!mention || selectionStart === undefined) {
    const next = `${text ? `${text} ` : ''}@${file} `
    return { text: next, caret: null }
  }
  const before = text.slice(0, mention.start)
  const after = text.slice(selectionStart)
  return { text: `${before}@${file} ${after}`, caret: before.length + file.length + 2 }
}

function applyMentionOpen(
  text: string,
  caret: number
): { text: string; mention: { query: string; start: number }; caret: number | null } {
  const active = mentionFromCaret(text, caret)
  if (active) return { text, mention: active, caret: null }
  return {
    text: `${text.slice(0, caret)}@${text.slice(caret)}`,
    mention: { query: '', start: caret },
    caret: caret + 1
  }
}

function focusCaret(node: HTMLTextAreaElement | null, caret: number): void {
  window.setTimeout(() => {
    node?.focus()
    node?.setSelectionRange(caret, caret)
  }, 0)
}

function navigateComposerHistory(
  direction: 'up' | 'down',
  textarea: HTMLTextAreaElement,
  text: string,
  history: string[],
  historyIndexRef: React.MutableRefObject<number | null>,
  draftRef: React.MutableRefObject<string>,
  setText: (value: string) => void
): boolean {
  if (direction === 'up') {
    const onFirstLine = textarea.value.slice(0, textarea.selectionStart).indexOf('\n') === -1
    if (!onFirstLine || !history.length) return false
    if (historyIndexRef.current === null) {
      draftRef.current = text
      historyIndexRef.current = history.length - 1
    } else if (historyIndexRef.current > 0) {
      historyIndexRef.current -= 1
    } else {
      return false
    }
    setText(history[historyIndexRef.current])
    return true
  }
  const onLastLine = textarea.value.slice(textarea.selectionEnd).indexOf('\n') === -1
  if (!onLastLine || historyIndexRef.current === null) return false
  if (historyIndexRef.current < history.length - 1) {
    historyIndexRef.current += 1
    setText(history[historyIndexRef.current])
  } else {
    historyIndexRef.current = null
    setText(draftRef.current)
  }
  return true
}

async function saveImageAttachments(
  projectPath: string,
  files: FileList | File[]
): Promise<{ attachments: PendingAttachment[]; error: string | null }> {
  const images = [...files].filter((file) => file.type.startsWith('image/'))
  if (!images.length) return { attachments: [], error: 'Only image files can be attached.' }
  try {
    const attachments: PendingAttachment[] = []
    let error: string | null = null
    for (const file of images) {
      const path = await window.farol.project.saveAttachment(
        projectPath,
        file.name,
        await file.arrayBuffer()
      )
      if (!path) {
        error = `Could not attach ${file.name}.`
        continue
      }
      attachments.push({ name: file.name, path, previewUrl: URL.createObjectURL(file) })
    }
    return { attachments, error }
  } catch {
    return { attachments: [], error: 'Could not save the attachment.' }
  }
}

function composerSurfaceStyle(dragOver: boolean): React.CSSProperties {
  return {
    maxWidth: 680,
    margin: '0 auto',
    background: dragOver ? '#1F2937' : '#111827',
    border: dragOver ? `1px solid ${C.accent}` : '1px solid #273449',
    borderRadius: 14,
    padding: '14px 16px 11px',
    position: 'relative',
    boxShadow: dragOver ? '0 0 0 1px rgba(37,99,235,.2)' : 'none'
  }
}

function handlePickerKeys(e: React.KeyboardEvent, picker: ComposerPicker | null): boolean {
  if (!picker) return false
  if (e.key === 'Escape') {
    e.preventDefault()
    picker.close()
    return true
  }
  if (!picker.count) return false
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    picker.setIndex((i) => Math.min(i + 1, picker.count - 1))
    return true
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    picker.setIndex((i) => Math.max(i - 1, 0))
    return true
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    picker.pick()
    return true
  }
  return false
}

function handleComposerKeyDown(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  opts: {
    picker: ComposerPicker | null
    send: () => void
    navigateHistory: (direction: 'up' | 'down', textarea: HTMLTextAreaElement) => boolean
  }
): void {
  if (handlePickerKeys(e, opts.picker)) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    opts.send()
    return
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (opts.navigateHistory(e.key === 'ArrowUp' ? 'up' : 'down', e.currentTarget)) {
      e.preventDefault()
    }
  }
}

function buildMessage(body: string, paths: string[]): string {
  const clean = body.trim()
  if (!paths.length) return clean
  const lines = paths.map((p) => `- ${p}`).join('\n')
  const block = `Attached images:\n${lines}`
  return clean ? `${clean}\n\n${block}` : block
}

const COMPOSER_TEXTAREA_STYLE: React.CSSProperties = {
  width: '100%',
  border: 'none',
  outline: 'none',
  resize: 'none',
  background: 'transparent',
  color: C.text,
  fontFamily: 'inherit',
  fontSize: 13.5,
  lineHeight: 1.5,
  minHeight: 40,
  maxHeight: 200,
  overflowY: 'auto',
  padding: 0,
  userSelect: 'text',
  WebkitUserSelect: 'text',
  caretColor: C.text
}

function ComposerToolbar({
  agentBtnRef,
  provider,
  model,
  canChangeProvider,
  isBusy,
  canSend,
  onNewChat,
  onOpenAgentMenu,
  onOpenMention,
  onCancel,
  onSend
}: {
  agentBtnRef: React.RefObject<HTMLButtonElement>
  provider: AiProvider
  model?: string
  canChangeProvider: boolean
  isBusy: boolean
  canSend: boolean
  onNewChat: () => void
  onOpenAgentMenu: () => void
  onOpenMention: () => void
  onCancel: () => void
  onSend: () => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <button
        type="button"
        className="bf-focus bf-composer-btn"
        onClick={onNewChat}
        title="Clear chat and start fresh"
        aria-label="Clear chat and start fresh"
        style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          border: 'none',
          background: '#1F2937',
          display: 'grid',
          placeItems: 'center',
          color: '#94A3B8',
          cursor: 'pointer',
          padding: 0
        }}
      >
        <ClearChatIcon size={14} color="#94A3B8" />
      </button>
      <span style={{ flex: 1 }} />
      <button
        ref={agentBtnRef}
        type="button"
        className="bf-focus"
        onClick={onOpenAgentMenu}
        title={`Agent: ${aiSelectionLabel(provider, model)}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          border: 'none',
          background: 'transparent',
          color: '#94A3B8',
          fontSize: 12,
          cursor: canChangeProvider ? 'pointer' : 'default',
          padding: '2px 4px',
          opacity: canChangeProvider ? 1 : 0.55
        }}
      >
        <span
          style={{
            maxWidth: 168,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {aiSelectionLabel(provider, model)}
        </span>
        <ChevronDown size={11} />
      </button>
      <button
        type="button"
        className="bf-focus"
        onClick={onOpenMention}
        title="Reference a file (@)"
        aria-label="Reference a file"
        style={{
          display: 'grid',
          placeItems: 'center',
          border: 'none',
          background: 'transparent',
          color: '#94A3B8',
          cursor: 'pointer',
          padding: 2
        }}
      >
        <ClipIcon />
      </button>
      <SendButton isBusy={isBusy} canSend={canSend} onCancel={onCancel} onSend={onSend} />
    </div>
  )
}

function ComposerOverlays({
  menuPos,
  skill,
  mention,
  agent
}: {
  menuPos: { left: number; bottom: number; width: number } | null
  skill: {
    query: string
    hits: AgentSkill[]
    index: number
    onHover: (i: number) => void
    onPick: (skill: AgentSkill) => void
  } | null
  mention: {
    query: string
    files: string[]
    index: number
    onHover: (i: number) => void
    onPick: (file: string) => void
  } | null
  agent: {
    pos: { left: number; bottom: number }
    provider: AiProvider
    model?: string
    onPick: (provider: AiProvider, model?: string) => void
    onClose: () => void
  } | null
}) {
  return (
    <>
      {skill && menuPos && (
        <ComposerPickerMenu
          label="Skills"
          menuPos={menuPos}
          empty={skill.query ? 'No matching skills' : 'No skills found'}
          items={skill.hits.map((item) => ({ key: item.name, label: item.name }))}
          index={skill.index}
          onHover={skill.onHover}
          onPick={(i) => {
            const item = skill.hits[i]
            if (item) skill.onPick(item)
          }}
        />
      )}
      {mention && menuPos && (
        <ComposerPickerMenu
          label="Files"
          menuPos={menuPos}
          empty={mention.query ? 'No matching files' : 'Type to filter project files…'}
          items={mention.files.map((file) => ({ key: file, label: `@${file}` }))}
          index={mention.index}
          onHover={mention.onHover}
          onPick={(i) => {
            const file = mention.files[i]
            if (file) mention.onPick(file)
          }}
        />
      )}
      {agent && (
        <CliModelMenu
          provider={agent.provider}
          model={agent.model}
          pos={{ left: agent.pos.left, bottom: agent.pos.bottom, width: 188 }}
          onPick={agent.onPick}
          onClose={agent.onClose}
        />
      )}
    </>
  )
}

function SendButton({
  isBusy,
  canSend,
  onCancel,
  onSend
}: {
  isBusy: boolean
  canSend: boolean
  onCancel: () => void
  onSend: () => void
}) {
  return (
    <div
      onClick={() => (isBusy ? onCancel() : onSend())}
      title={isBusy ? 'Stop' : 'Send'}
      style={{
        width: 34,
        height: 30,
        borderRadius: 9,
        background: isBusy ? C.red : canSend ? C.accent : '#1F2937',
        display: 'grid',
        placeItems: 'center',
        cursor: isBusy || canSend ? 'pointer' : 'default'
      }}
    >
      {isBusy ? (
        <span style={{ width: 10, height: 10, borderRadius: 2, background: '#fff' }} />
      ) : (
        <SendIcon />
      )}
    </div>
  )
}

function ComposerBox({
  projectPath,
  availableCount,
  isBusy,
  provider,
  model,
  canChangeProvider,
  textareaRef,
  onMessage,
  onCancel,
  onProviderChange,
  onNewChat,
  onProviderLocal,
  sendTextRef
}: {
  projectPath: string
  availableCount: number
  isBusy: boolean
  provider: AiProvider
  model?: string
  canChangeProvider: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement>
  onMessage: (text: string, provider: AiProvider, model?: string) => void
  onCancel: () => void
  onProviderChange: (provider: AiProvider, model?: string) => void
  onNewChat: () => void
  onProviderLocal: (provider: AiProvider, model?: string) => void
  /** Lets the parent fire the same send path suggestions used before (incl. history). */
  sendTextRef: React.MutableRefObject<(clean: string) => void>
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [savingAttachments, setSavingAttachments] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [agentMenuPos, setAgentMenuPos] = useState<{ left: number; bottom: number } | null>(null)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [mentionFiles, setMentionFiles] = useState<string[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [skillQuery, setSkillQuery] = useState<string | null>(null)
  const [skillIndex, setSkillIndex] = useState(0)
  const [skillWarning, setSkillWarning] = useState<string[]>([])
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const composerBoxRef = useRef<HTMLDivElement>(null)
  const agentBtnRef = useRef<HTMLButtonElement>(null)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef<number | null>(null)
  const draftRef = useRef('')
  const skillsRef = useRef<AgentSkill[]>([])
  const providerRef = useRef(provider)
  const skillHits = skillQuery !== null ? filterSkills(skills, skillQuery) : []
  const skillWarnText = skillWarningLine(skillWarning, provider)

  const canSend =
    (!!text.trim() || attachments.length > 0) && availableCount > 0 && savingAttachments === 0

  useEffect(() => {
    const node = textareaRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`
  }, [text, textareaRef])

  useEffect(() => {
    if (!mention) {
      setMentionFiles([])
      return
    }
    let cancelled = false
    void window.farol.project.listFiles(projectPath, mention.query).then((files) => {
      if (!cancelled) {
        setMentionFiles(files.slice(0, 40))
        setMentionIndex(0)
      }
    })
    return () => {
      cancelled = true
    }
  }, [mention, projectPath])

  useEffect(() => {
    let cancelled = false
    void window.farol.project.listSkills(projectPath, provider).then((next) => {
      if (cancelled) return
      const from = providerRef.current
      if (from !== provider) {
        const prevNames = new Set(skillsRef.current.map((skill) => skill.name))
        const nextNames = new Set(next.map((skill) => skill.name))
        const result = convertSkillDraft(
          textareaRef.current?.value ?? '',
          provider,
          nextNames,
          prevNames
        )
        setText(result.text)
        setSkillWarning(result.unavailable)
        setSkillQuery(null)
        providerRef.current = provider
      }
      skillsRef.current = next
      setSkills(next)
    })
    return () => {
      cancelled = true
    }
  }, [projectPath, provider])

  useEffect(() => {
    setSkillIndex(0)
  }, [skillQuery, skills])

  const pickerOpen = mention !== null || skillQuery !== null
  useEffect(() => {
    if (!pickerOpen) {
      setMenuPos(null)
      return
    }
    const place = (): void => {
      const box = composerBoxRef.current
      if (!box) return
      const r = box.getBoundingClientRect()
      setMenuPos({ left: r.left, bottom: window.innerHeight - r.top + 8, width: r.width })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [pickerOpen])

  const openAgentMenu = (): void => {
    if (!canChangeProvider) return
    const r = agentBtnRef.current?.getBoundingClientRect()
    if (r) {
      setAgentMenuPos({
        left: Math.min(Math.max(8, r.right - 188), window.innerWidth - 196),
        bottom: window.innerHeight - r.top + 6
      })
    }
    setModelOpen((v) => !v)
  }

  const insertSkill = (skill: AgentSkill): void => {
    const next = insertSkillText(text, skill.token)
    setText(next.text)
    setSkillQuery(null)
    setSkillWarning((names) => retainSkillWarning(next.text, names))
    focusCaret(textareaRef.current, next.caret)
  }

  const insertMention = (file: string): void => {
    const node = textareaRef.current
    const next = applyMentionInsert(text, mention, node?.selectionStart, file)
    setText(next.text)
    setMention(null)
    if (next.caret !== null) focusCaret(node, next.caret)
  }

  const openMentionPicker = (): void => {
    const node = textareaRef.current
    const next = applyMentionOpen(text, node?.selectionStart ?? text.length)
    if (next.text !== text) setText(next.text)
    setMention(next.mention)
    if (next.caret === null) node?.focus()
    else focusCaret(node, next.caret)
  }

  const syncComposerPickers = (value: string, caret: number): void => {
    const next = composerPickerState(value, caret)
    setSkillQuery(next.skillQuery)
    setMention(next.mention)
  }

  const sendText = (clean: string): void => {
    if (!clean) return
    onMessage(clean, provider, model)
    const history = historyRef.current
    if (history[history.length - 1] !== clean) history.push(clean)
    if (history.length > 100) history.splice(0, history.length - 100)
    historyIndexRef.current = null
    draftRef.current = ''
  }
  sendTextRef.current = sendText

  const addImageFiles = (files: FileList | File[]): void => {
    if (![...files].some((file) => file.type.startsWith('image/'))) {
      setAttachmentError('Only image files can be attached.')
      return
    }
    setAttachmentError(null)
    setSavingAttachments((count) => count + 1)
    void saveImageAttachments(projectPath, files)
      .then((result) => {
        setAttachmentError(result.error)
        if (result.attachments.length) setAttachments((prev) => [...prev, ...result.attachments])
      })
      .finally(() => setSavingAttachments((count) => count - 1))
  }

  const removeAttachment = (path: string): void => {
    setAttachments((prev) => {
      const item = prev.find((attachment) => attachment.path === path)
      if (item) URL.revokeObjectURL(item.previewUrl)
      return prev.filter((attachment) => attachment.path !== path)
    })
  }

  const send = (): void => {
    const paths = attachments.map((attachment) => attachment.path)
    const clean = buildMessage(text, paths)
    if (!clean) return
    sendText(clean)
    setText('')
    setMention(null)
    setSkillQuery(null)
    setSkillWarning([])
    for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl)
    setAttachments([])
  }

  const picker =
    skillQuery !== null
      ? pickerHandle(skillHits, skillIndex, setSkillIndex, () => setSkillQuery(null), insertSkill)
      : mention
        ? pickerHandle(mentionFiles, mentionIndex, setMentionIndex, () => setMention(null), insertMention)
        : null
  const skillOverlay =
    skillQuery !== null
      ? {
          query: skillQuery,
          hits: skillHits,
          index: skillIndex,
          onHover: setSkillIndex,
          onPick: insertSkill
        }
      : null
  const mentionOverlay = mention
    ? {
        query: mention.query,
        files: mentionFiles,
        index: mentionIndex,
        onHover: setMentionIndex,
        onPick: insertMention
      }
    : null
  const agentOverlay =
    modelOpen && agentMenuPos && canChangeProvider
      ? {
          pos: agentMenuPos,
          provider,
          model,
          onPick: (p: AiProvider, m?: string) => {
            onProviderLocal(p, m)
            onProviderChange(p, m)
            setModelOpen(false)
            window.setTimeout(() => textareaRef.current?.focus(), 0)
          },
          onClose: () => setModelOpen(false)
        }
      : null

  return (
    <div style={{ flex: 'none', padding: '8px 34px 20px' }}>
      <div
        ref={composerBoxRef}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files.length) addImageFiles(e.dataTransfer.files)
        }}
        style={composerSurfaceStyle(dragOver)}
      >
        {attachments.length > 0 && (
          <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
        )}
        {attachmentError && (
          <div style={{ fontSize: 12, color: '#EF4444', marginBottom: 8 }}>{attachmentError}</div>
        )}
        {skillWarnText && (
          <div style={{ fontSize: 12, color: '#EF4444', marginBottom: 8 }}>{skillWarnText}</div>
        )}
        {savingAttachments > 0 && (
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>Saving attachment…</div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            const value = e.target.value
            setText(value)
            setSkillWarning((names) => retainSkillWarning(value, names))
            syncComposerPickers(value, e.target.selectionStart)
          }}
          onSelect={(e) => syncComposerPickers(e.currentTarget.value, e.currentTarget.selectionStart)}
          onKeyDown={(e) =>
            handleComposerKeyDown(e, {
              picker,
              send,
              navigateHistory: (direction, textarea) =>
                navigateComposerHistory(
                  direction,
                  textarea,
                  text,
                  historyRef.current,
                  historyIndexRef,
                  draftRef,
                  setText
                )
            })
          }
          placeholder={composerPlaceholder(availableCount, attachments.length > 0)}
          disabled={!availableCount}
          rows={1}
          style={COMPOSER_TEXTAREA_STYLE}
        />
        <ComposerToolbar
          agentBtnRef={agentBtnRef}
          provider={provider}
          model={model}
          canChangeProvider={canChangeProvider}
          isBusy={isBusy}
          canSend={canSend}
          onNewChat={onNewChat}
          onOpenAgentMenu={openAgentMenu}
          onOpenMention={openMentionPicker}
          onCancel={onCancel}
          onSend={send}
        />
      </div>

      <ComposerOverlays
        menuPos={menuPos}
        skill={skillOverlay}
        mention={mentionOverlay}
        agent={agentOverlay}
      />
    </div>
  )
}

function MessageList({
  messages,
  isBusy,
  provider,
  onOpenPipeline,
  onNewChat,
  onAnswer
}: {
  messages: AgentMessage[]
  isBusy: boolean
  provider: AiProvider
  onOpenPipeline: (tabId: string) => void
  onNewChat: () => void
  onAnswer: (requestId: string, answers: string[][] | null) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 26, marginTop: 40 }}>
      {messages.map((m, i) => (
        <MessageErrorBoundary key={i}>
          <Turn
            m={m}
            i={i}
            messages={messages}
            isBusy={isBusy}
            provider={provider}
            onOpenPipeline={onOpenPipeline}
            onNewChat={onNewChat}
            onAnswer={onAnswer}
          />
        </MessageErrorBoundary>
      ))}
    </div>
  )
}

function ChatBanners({
  clearChatConfirm,
  chatClearedNotice,
  hasMessages,
  onCancelClearChat,
  onConfirmClearChat,
  onDismissChatCleared
}: {
  clearChatConfirm?: boolean
  chatClearedNotice?: boolean
  hasMessages: boolean
  onCancelClearChat?: () => void
  onConfirmClearChat?: () => void
  onDismissChatCleared?: () => void
}) {
  return (
    <>
      {clearChatConfirm && (
        <ClearChatBanner
          onCancelClearChat={onCancelClearChat}
          onConfirmClearChat={onConfirmClearChat}
        />
      )}
      {chatClearedNotice && !hasMessages && (
        <ChatClearedBanner onDismissChatCleared={onDismissChatCleared} />
      )}
    </>
  )
}

export default function ChatPane({
  pane,
  pipelines,
  view,
  projectPath,
  defaultProvider,
  defaultModel,
  onMessage,
  onAnswer,
  onCancel,
  onProviderChange,
  onOpenPipeline,
  onNewChat,
  clearChatConfirm,
  onConfirmClearChat,
  onCancelClearChat,
  chatClearedNotice,
  onDismissChatCleared,
  composerRef
}: Props) {
  const [provider, setProvider] = useState<AiProvider>(normalizeAi(pane?.provider ?? defaultProvider))
  const [model, setModel] = useState<string | undefined>(normalizeModel(pane?.model ?? defaultModel))
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const localRef = useRef<HTMLTextAreaElement>(null)
  const textareaRef = composerRef ?? localRef
  const sendTextRef = useRef<(clean: string) => void>(() => {})

  const status = pane?.status ?? 'idle'
  const isBusy = busy.has(status)
  // Allow switching while busy so a usage/session limit can be escaped without
  // waiting for the dying CLI to exit — the next message uses the new provider.
  const canChangeProvider = true
  const messages = pane?.messages ?? []
  const availableCount = pipelines.filter((p) => p.nodes.length).length
  const showSuggestions = messages.length < 3 && availableCount > 0

  useEffect(() => {
    setProvider(normalizeAi(pane?.provider ?? defaultProvider))
    setModel(normalizeModel(pane?.model ?? defaultModel))
  }, [pane?.provider, pane?.model, defaultProvider, defaultModel])

  // Follow the stream only while the reader is already at the bottom, so
  // scrolling up to read something does not get yanked back by the next event.
  useEffect(() => {
    const node = scrollRef.current
    if (node && stickRef.current) node.scrollTop = node.scrollHeight
  }, [messages])

  const flex = view === 'split' ? '1 1 50%' : '1 1 100%'

  return (
    <div style={{ ...PANE, flex, overflow: 'visible' }}>
      <ChatBanners
        clearChatConfirm={clearChatConfirm}
        chatClearedNotice={chatClearedNotice}
        hasMessages={messages.length > 0}
        onCancelClearChat={onCancelClearChat}
        onConfirmClearChat={onConfirmClearChat}
        onDismissChatCleared={onDismissChatCleared}
      />
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const node = e.currentTarget
          stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_SLACK
        }}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '40px 34px 8px' }}
      >
        <div style={{ maxWidth: 680, margin: '0 auto' }}>
          <ChatGreeting availableCount={availableCount} />
          {showSuggestions && <SuggestionList onPick={(p) => sendTextRef.current(p)} />}
          <MessageList
            messages={messages}
            isBusy={isBusy}
            provider={provider}
            onOpenPipeline={onOpenPipeline}
            onNewChat={onNewChat}
            onAnswer={onAnswer}
          />
          <div style={{ height: 12 }} />
        </div>
      </div>

      <ComposerBox
        projectPath={projectPath}
        availableCount={availableCount}
        isBusy={isBusy}
        provider={provider}
        model={model}
        canChangeProvider={canChangeProvider}
        textareaRef={textareaRef}
        onMessage={onMessage}
        onCancel={onCancel}
        onProviderChange={onProviderChange}
        onNewChat={onNewChat}
        onProviderLocal={(p, m) => {
          setProvider(p)
          setModel(m)
        }}
        sendTextRef={sendTextRef}
      />
    </div>
  )
}
