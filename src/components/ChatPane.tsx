import { useEffect, useRef, useState } from 'react'
import type { AiProvider, Pipeline } from '@shared/types'
import { AI_LABELS, aiSelectionLabel, normalizeAi, normalizeModel } from '@shared/ai'
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
  SearchIcon,
  SendIcon,
  Spinner,
  StatusMark,
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
  {
    label: 'Validate',
    detail: 'Run every validation pipeline',
    prompt: 'Run every available validation pipeline before I open a PR',
    Icon: CheckIcon
  },
  {
    label: 'Explain',
    detail: 'What this pipeline checks',
    prompt: 'Walk me through what the selected pipeline checks and why',
    Icon: ToolIcon
  },
  {
    label: 'Investigate',
    detail: 'Why the last run failed',
    prompt: 'Investigate why the last run failed and suggest a fix',
    Icon: SearchIcon
  }
] as const

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
        background: '#232322',
        border: '1px solid #3E3E3A',
        borderRadius: 9
      }}
    >
      <ToolIcon />
      <span style={{ fontFamily: MONO, fontSize: 11.5, color: '#C4C4BE', flex: 'none' }}>
        {tool.name}
      </span>
      {tool.detail && (
        <span
          title={tool.detail}
          style={{
            fontFamily: MONO,
            fontSize: 11.5,
            color: '#A1A19A',
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
        <StatusMark done size={18} />
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
        border: '1px solid #3E3E3A',
        borderRadius: 11,
        overflow: 'hidden',
        background: '#232322'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '11px 14px',
          borderBottom: '1px solid #3E3E3A'
        }}
      >
        <ToolIcon />
        <span style={{ fontFamily: MONO, fontSize: 12, color: '#C4C4BE' }}>
          pipeline: {pc.pipelineName}
        </span>
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
        <span
          className="bf-linkish"
          onClick={() => onOpenPipeline(pc.tabId)}
          style={{ fontSize: 11.5, color: '#A1A19A', cursor: 'pointer' }}
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
          color: '#A1A19A',
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#A1A19A' }}>
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
        border: selected ? '1px solid #D6F23A' : '1px solid #3E3E3A',
        borderRadius: 8,
        background: selected ? 'rgba(214, 242, 58,0.12)' : 'transparent',
        color: '#D8D8D3',
        cursor: locked ? 'default' : 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit'
      }}
    >
      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{option.label}</span>
      {option.description && (
        <span style={{ fontSize: 12, lineHeight: 1.4, color: '#A1A19A' }}>{option.description}</span>
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
        border: '1px solid #3E3E3A',
        borderRadius: 11,
        overflow: 'hidden',
        background: '#232322'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '11px 14px',
          borderBottom: '1px solid #3E3E3A'
        }}
      >
        <ToolIcon />
        <span style={{ fontFamily: MONO, fontSize: 12, color: '#C4C4BE' }}>
          {card.dismissed
            ? 'questions dismissed'
            : `question${card.questions.length === 1 ? '' : 's'}`}
        </span>
        {locked && !card.dismissed ? <StatusMark done size={18} /> : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '13px 15px' }}>
        {card.questions.map((question, qi) => {
          const selected = new Set(card.answers?.[qi] ?? picks[qi])
          const extras = (card.answers?.[qi] ?? []).filter(
            (label) => !question.options.some((option) => option.label === label)
          )
          return (
            <div key={`${card.requestId}-${qi}`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#777772', letterSpacing: '0.02em' }}>
                {question.header}
              </div>
              <div style={{ fontSize: 13.5, lineHeight: 1.45, color: '#D8D8D3' }}>{question.question}</div>
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
                    border: '1px solid #3E3E3A',
                    borderRadius: 8,
                    background: '#181817',
                    color: '#F0F0EC',
                    fontSize: 12.5,
                    padding: '7px 10px',
                    outline: 'none',
                    fontFamily: 'inherit'
                  }}
                />
              )}
              {locked && extras.length > 0 && (
                <div style={{ fontSize: 12, color: '#A1A19A' }}>{extras.join(', ')}</div>
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
                border: '1px solid #3E3E3A',
                background: 'transparent',
                color: '#A1A19A',
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
                background: ready ? C.accent : '#2D2D2B',
                color: ready ? C.accentInk : '#777772',
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
            background: '#2D2D2B',
            border: '1px solid #3E3E3A',
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
          <span style={{ fontSize: 11, color: '#777772' }}>{fmtClock(m.at)}</span>
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
            color: '#A1A19A',
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
        background: '#232322',
        border: '1px solid #3E3E3A',
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
            border: '1px solid #3E3E3A',
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
            background: 'rgba(255, 98, 90,0.16)',
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
        background: '#232322',
        border: '1px solid #3E3E3A',
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
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      <img
        src={farolMark}
        alt=""
        width={36}
        height={36}
        draggable={false}
        style={{ borderRadius: 10, display: 'block' }}
      />
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: '-0.4px',
          marginTop: 18,
          color: C.textStrong
        }}
      >
        {greetingFor(new Date())}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.55, color: C.textMuted, marginTop: 8, maxWidth: 420 }}>
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
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 8,
        marginTop: 12,
        paddingBottom: 8
      }}
    >
      {SUGGESTIONS.map(({ label, detail, prompt, Icon }) => (
        <button
          key={label}
          type="button"
          className="bf-tile bf-focus"
          onClick={() => onPick(prompt)}
          title={prompt}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 18,
            minHeight: 92,
            padding: '14px 14px 12px',
            margin: 0,
            background: '#232322',
            border: '1px solid #3E3E3A',
            borderRadius: 12,
            cursor: 'pointer',
            textAlign: 'left',
            color: C.textStrong,
            fontFamily: 'inherit'
          }}
        >
          <span style={{ color: '#A1A19A', display: 'grid' }}>
            <Icon size={16} color="#A1A19A" />
          </span>
          <span>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{label}</span>
            <span style={{ display: 'block', fontSize: 12, lineHeight: 1.4, color: C.textMuted, marginTop: 3 }}>
              {detail}
            </span>
          </span>
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
            border: '1px solid #3E3E3A',
            background: '#181817'
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

function MentionMenu({
  menuPos,
  mentionQuery,
  mentionFiles,
  mentionIndex,
  onHover,
  onPick
}: {
  menuPos: { left: number; bottom: number; width: number }
  mentionQuery: string
  mentionFiles: string[]
  mentionIndex: number
  onHover: (i: number) => void
  onPick: (file: string) => void
}) {
  return (
    <div
      role="listbox"
      aria-label="Files"
      style={{
        position: 'fixed',
        left: menuPos.left,
        bottom: menuPos.bottom,
        width: menuPos.width,
        zIndex: 70,
        maxHeight: 220,
        overflow: 'auto',
        background: '#232322',
        border: `1px solid ${C.cardBorder}`,
        borderRadius: 10,
        boxShadow: '0 14px 36px rgba(0,0,0,0.5)',
        padding: 4
      }}
    >
      {!mentionFiles.length ? (
        <div style={{ padding: '10px 12px', fontSize: 12, color: C.textMuted }}>
          {mentionQuery ? 'No matching files' : 'Type to filter project files…'}
        </div>
      ) : (
        mentionFiles.map((file, i) => (
          <button
            key={file}
            type="button"
            role="option"
            aria-selected={i === mentionIndex}
            className="bf-focus bf-menu-item"
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(file)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              border: 'none',
              background: i === mentionIndex ? '#2D2D2B' : 'transparent',
              color: C.textSoft,
              fontFamily: MONO,
              fontSize: 12,
              cursor: 'pointer'
            }}
          >
            @{file}
          </button>
        ))
      )}
    </div>
  )
}

function AgentMenu({
  agentMenuPos,
  provider,
  model,
  onPick,
  onClose
}: {
  agentMenuPos: { left: number; bottom: number }
  provider: AiProvider
  model?: string
  onPick: (p: AiProvider, model?: string) => void
  onClose: () => void
}) {
  return (
    <CliModelMenu
      provider={provider}
      model={model}
      pos={{ left: agentMenuPos.left, bottom: agentMenuPos.bottom, width: 188 }}
      onPick={onPick}
      onClose={onClose}
    />
  )
}

function composerPlaceholder(availableCount: number, hasAttachments: boolean): string {
  if (!availableCount) return 'Create a validation pipeline to start'
  if (hasAttachments) return 'Add a message or send the attached images…'
  return 'Message the agent… (drop images here)'
}

function handleComposerKeyDown(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  opts: {
    mention: { query: string; start: number } | null
    mentionFiles: string[]
    mentionIndex: number
    setMentionIndex: React.Dispatch<React.SetStateAction<number>>
    setMention: (v: null) => void
    insertMention: (file: string) => void
    send: () => void
    navigateHistory: (direction: 'up' | 'down', textarea: HTMLTextAreaElement) => boolean
  }
): void {
  const {
    mention,
    mentionFiles,
    mentionIndex,
    setMentionIndex,
    setMention,
    insertMention,
    send,
    navigateHistory
  } = opts
  if (mention && mentionFiles.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setMentionIndex((i) => Math.min(i + 1, mentionFiles.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setMentionIndex((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      insertMention(mentionFiles[mentionIndex] ?? mentionFiles[0])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setMention(null)
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
    return
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (navigateHistory(e.key === 'ArrowUp' ? 'up' : 'down', e.currentTarget)) {
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
        background: isBusy ? C.red : canSend ? C.accent : '#2D2D2B',
        color: !isBusy && canSend ? C.accentInk : C.text,
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
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const composerBoxRef = useRef<HTMLDivElement>(null)
  const agentBtnRef = useRef<HTMLButtonElement>(null)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef<number | null>(null)
  const draftRef = useRef('')

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
    if (!mention) {
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
  }, [mention])

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

  const insertMention = (file: string): void => {
    const node = textareaRef.current
    if (!mention || !node) {
      setText((t) => (t ? `${t} ` : '') + `@${file} `)
      setMention(null)
      return
    }
    const before = text.slice(0, mention.start)
    const after = text.slice(node.selectionStart)
    const next = `${before}@${file} ${after}`
    setText(next)
    setMention(null)
    window.setTimeout(() => {
      const pos = before.length + file.length + 2
      node.focus()
      node.setSelectionRange(pos, pos)
    }, 0)
  }

  const openMentionPicker = (): void => {
    const node = textareaRef.current
    const caret = node?.selectionStart ?? text.length
    const prefix = text.slice(0, caret)
    const at = prefix.lastIndexOf('@')
    const active = at >= 0 && !/\s/.test(prefix.slice(at + 1))
    if (active) {
      setMention({ query: prefix.slice(at + 1), start: at })
      node?.focus()
      return
    }
    const next = `${text.slice(0, caret)}@${text.slice(caret)}`
    setText(next)
    setMention({ query: '', start: caret })
    window.setTimeout(() => {
      node?.focus()
      node?.setSelectionRange(caret + 1, caret + 1)
    }, 0)
  }

  const syncMentionFromValue = (value: string, caret: number): void => {
    const prefix = value.slice(0, caret)
    const at = prefix.lastIndexOf('@')
    if (at === -1) {
      setMention(null)
      return
    }
    const body = prefix.slice(at + 1)
    if (/\s/.test(body)) {
      setMention(null)
      return
    }
    setMention({ query: body, start: at })
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
    const images = [...files].filter((file) => file.type.startsWith('image/'))
    if (!images.length) {
      setAttachmentError('Only image files can be attached.')
      return
    }
    setAttachmentError(null)
    setSavingAttachments((count) => count + 1)
    void (async () => {
      try {
        const next: PendingAttachment[] = []
        for (const file of images) {
          const buffer = await file.arrayBuffer()
          const path = await window.farol.project.saveAttachment(projectPath, file.name, buffer)
          if (!path) {
            setAttachmentError(`Could not attach ${file.name}.`)
            continue
          }
          next.push({ name: file.name, path, previewUrl: URL.createObjectURL(file) })
        }
        if (next.length) setAttachments((prev) => [...prev, ...next])
      } catch {
        setAttachmentError('Could not save the attachment.')
      } finally {
        setSavingAttachments((count) => count - 1)
      }
    })()
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
    for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl)
    setAttachments([])
  }

  const navigateHistory = (direction: 'up' | 'down', textarea: HTMLTextAreaElement): boolean => {
    const history = historyRef.current
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

  return (
    <div style={{ flex: 'none', padding: '8px 34px 20px' }}>
      <div
        ref={composerBoxRef}
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes('Files')) return
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
        style={{
          maxWidth: 680,
          margin: '0 auto',
          background: dragOver ? '#2D2D2B' : '#232322',
          border: dragOver ? `1px solid ${C.accent}` : '1px solid #3E3E3A',
          borderRadius: 14,
          padding: '14px 16px 11px',
          position: 'relative',
          boxShadow: dragOver ? '0 0 0 1px rgba(214, 242, 58,.2)' : 'none'
        }}
      >
        {attachments.length > 0 && (
          <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
        )}
        {attachmentError && (
          <div style={{ fontSize: 12, color: '#FF625A', marginBottom: 8 }}>{attachmentError}</div>
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
            syncMentionFromValue(value, e.target.selectionStart)
          }}
          onKeyDown={(e) =>
            handleComposerKeyDown(e, {
              mention,
              mentionFiles,
              mentionIndex,
              setMentionIndex,
              setMention,
              insertMention,
              send,
              navigateHistory
            })
          }
          placeholder={composerPlaceholder(availableCount, attachments.length > 0)}
          disabled={!availableCount}
          rows={1}
          style={{
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
          } as React.CSSProperties}
        />
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
              background: '#2D2D2B',
              display: 'grid',
              placeItems: 'center',
              color: '#A1A19A',
              cursor: 'pointer',
              padding: 0
            }}
          >
            <ClearChatIcon size={14} color="#A1A19A" />
          </button>
          <span style={{ flex: 1 }} />
          <button
            ref={agentBtnRef}
            type="button"
            className="bf-focus"
            onClick={openAgentMenu}
            title={`Agent: ${aiSelectionLabel(provider, model)}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              border: 'none',
              background: 'transparent',
              color: '#A1A19A',
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
            onClick={openMentionPicker}
            title="Reference a file (@)"
            aria-label="Reference a file"
            style={{
              display: 'grid',
              placeItems: 'center',
              border: 'none',
              background: 'transparent',
              color: '#A1A19A',
              cursor: 'pointer',
              padding: 2
            }}
          >
            <ClipIcon />
          </button>
          <SendButton isBusy={isBusy} canSend={canSend} onCancel={onCancel} onSend={send} />
        </div>
      </div>

      {mention && menuPos && (
        <MentionMenu
          menuPos={menuPos}
          mentionQuery={mention.query}
          mentionFiles={mentionFiles}
          mentionIndex={mentionIndex}
          onHover={setMentionIndex}
          onPick={insertMention}
        />
      )}

      {modelOpen && agentMenuPos && canChangeProvider && (
        <AgentMenu
          agentMenuPos={agentMenuPos}
          provider={provider}
          model={model}
          onClose={() => setModelOpen(false)}
          onPick={(p, m) => {
            onProviderLocal(p, m)
            onProviderChange(p, m)
            setModelOpen(false)
            window.setTimeout(() => textareaRef.current?.focus(), 0)
          }}
        />
      )}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
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
  const showSuggestions = availableCount > 0

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
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '36px 28px 8px',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <div
          style={{
            maxWidth: 680,
            margin: '0 auto',
            width: '100%',
            minHeight: '100%',
            display: 'flex',
            flexDirection: 'column',
            boxSizing: 'border-box'
          }}
        >
          {messages.length === 0 ? (
            <>
              <ChatGreeting availableCount={availableCount} />
              <div style={{ flex: 1, minHeight: 24 }} />
              {showSuggestions && <SuggestionList onPick={(p) => sendTextRef.current(p)} />}
            </>
          ) : (
            <MessageList
              messages={messages}
              isBusy={isBusy}
              provider={provider}
              onOpenPipeline={onOpenPipeline}
              onNewChat={onNewChat}
              onAnswer={onAnswer}
            />
          )}
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
