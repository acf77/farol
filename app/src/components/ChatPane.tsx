import { useEffect, useRef, useState } from 'react'
import type { AgentMode, AgentSkill, AiProvider, AppSettings, Pipeline, ProviderUsage } from '@shared/types'
import { AI_LABELS, aiSelectionLabel, hasReviewGate, normalizeAi, normalizeModel } from '@shared/ai'
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
import { Button, CliModelMenu } from './controls'
import UsageBar from './UsageBar'
import TodoList from './TodoList'
import {
  AttachmentIcon,
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
  settings?: AppSettings
  usage: ProviderUsage[]
  onRefreshUsage: () => void
  onMessage: (text: string, provider: AiProvider, model: string | undefined, mode: AgentMode) => void
  /** `answers: null` dismisses the chooser. */
  onAnswer: (requestId: string, answers: string[][] | null) => void
  onCancel: () => void
  onProviderChange: (provider: AiProvider, model?: string) => void
  onModeChange: (mode: AgentMode) => void
  onExecutePlan: (index: number) => void
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
  type: string
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
        border: `1px solid ${C.cardBorder}`,
        borderRadius: 12,
        overflow: 'hidden',
        background: C.card,
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
          borderBottom: children ? `1px solid ${C.cardBorder}` : undefined
        }}
      >
        <ToolIcon />
        <span
          style={{
            fontFamily: MONO,
            fontSize: compact ? 11.5 : 12,
            color: '#C4C4BE',
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

function ChatBanner({
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
        background: C.card,
        border: `1px solid ${C.cardBorder}`,
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
function ToolCard({ tool, tight }: { tool: NonNullable<AgentMessage['tool']>; tight: boolean }) {
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
        </>
      }
    />
  )
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
              fontSize: 11.5,
              color: '#A1A19A',
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
          color: '#A1A19A',
          userSelect: 'text'
        }}
      >
        {text}
      </div>
    </ChatCard>
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
        border: selected ? `1px solid ${C.accent}` : `1px solid ${C.cardBorder}`,
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
                    border: `1px solid ${C.cardBorder}`,
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

function Turn({
  m,
  i,
  messages,
  isBusy,
  provider,
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
  onOpenPipeline: (tabId: string) => void
  onNewChat: () => void
  onAnswer: (requestId: string, answers: string[][] | null) => void
  canExecutePlan: boolean
  onExecutePlan: (index: number) => void
}) {
  if (m.role === 'user') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 7 }}>
        <div
          style={{
            maxWidth: 430,
            padding: '11px 15px',
            background: C.panel,
            border: `1px solid ${C.cardBorder}`,
            borderRadius: 12,
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
          <span style={{ fontSize: 11, color: '#777772' }}>{fmtClock(m.at)}</span>
        )}
      </div>
    )
  }

  if (m.question) return <QuestionCard card={m.question} onAnswer={onAnswer} />
  if (m.tool) return <ToolCard tool={m.tool} tight={!!messages[i - 1]?.tool} />

  const pc = m.pipeline
  const showFooter = m.role === 'assistant' && i === messages.length - 1 && !isBusy

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 15, minWidth: 0 }}>
      {pc ? (
        <PipelineMsgCard pc={pc} text={m.text} onOpenPipeline={onOpenPipeline} />
      ) : m.role === 'assistant' ? (
        <MarkdownBody text={m.text} />
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
          {m.text}
        </div>
      )}

      {canExecutePlan && <ExecutePlanButton onExecute={() => onExecutePlan(i)} />}
      {showFooter && <AssistantFooter text={m.text} provider={provider} onNewChat={onNewChat} />}
    </div>
  )
}

function ExecutePlanButton({ onExecute }: { onExecute: () => void }) {
  return (
    <Button variant="primary" onClick={onExecute} style={{ alignSelf: 'flex-start' }}>
      Execute plan
    </Button>
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
    <ChatBanner
      role="alertdialog"
      labelledBy="clear-chat-title"
      describedBy="clear-chat-desc"
      style={{ flexWrap: 'wrap', gap: '10px 14px' }}
    >
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div id="clear-chat-title" style={{ fontSize: 13.5, fontWeight: 600, color: C.textSoft }}>
          Clear this conversation?
        </div>
        <div id="clear-chat-desc" style={{ fontSize: 12.5, lineHeight: 1.45, color: C.textMuted, marginTop: 4 }}>
          Clearing permanently deletes this branch&apos;s current messages.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
        <Button onClick={onCancelClearChat}>Cancel</Button>
        <Button
          variant="danger"
          onClick={onConfirmClearChat}
          style={{ background: 'rgba(255, 98, 90,0.16)' }}
        >
          Clear chat
        </Button>
      </div>
    </ChatBanner>
  )
}

function ChatClearedBanner({ onDismissChatCleared }: { onDismissChatCleared?: () => void }) {
  return (
    <ChatBanner role="status">
      <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.45, color: C.textMuted }}>
        Conversation cleared. Previous messages were removed from this branch. Switch to another
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
    </ChatBanner>
  )
}

function ChatGreeting({ availableCount, mode }: { availableCount: number; mode: AgentMode }) {
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
        {availableCount || mode === 'plan'
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
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
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
            background: C.card,
            border: `1px solid ${C.cardBorder}`,
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

function attachmentKind({ name, type }: PendingAttachment): string {
  if (
    type.startsWith('image/') ||
    /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?|ico)$/i.test(name)
  ) return 'Image'
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 'PDF'
  if (type === 'text/html' || /\.html?$/i.test(name)) return 'HTML'
  return name.match(/\.([a-z0-9]+)$/i)?.[1].toUpperCase() ?? 'File'
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
      {attachments.map((attachment) => {
        const kind = attachmentKind(attachment)
        return (
          <div
            key={attachment.path}
            title={attachment.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: 220,
              maxWidth: '100%',
              minWidth: 0,
              boxSizing: 'border-box',
              padding: '10px',
              borderRadius: 8,
              border: `1px solid ${C.cardBorder}`,
              background: C.terminal,
              color: C.textMuted
            }}
          >
            <AttachmentIcon kind={kind} size={24} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: C.textSoft
                }}
              >
                {attachment.name}
              </div>
              <div style={{ fontSize: 11, marginTop: 3 }}>{kind}</div>
            </div>
            <button
              type="button"
              className="bf-focus bf-composer-btn"
              onClick={() => onRemove(attachment.path)}
              title={`Remove ${attachment.name}`}
              aria-label={`Remove ${attachment.name}`}
              style={{
                flex: 'none',
                width: 26,
                height: 26,
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                color: C.textMuted,
                fontSize: 16,
                lineHeight: 1,
                cursor: 'pointer',
                display: 'grid',
                placeItems: 'center'
              }}
            >
              ×
            </button>
          </div>
        )
      })}
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
        background: C.card,
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
              background: i === index ? C.panel : 'transparent',
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

function composerPlaceholder(availableCount: number, hasAttachments: boolean, mode: AgentMode): string {
  if (!availableCount && mode === 'build') return 'Create a validation pipeline to start'
  if (hasAttachments) return 'Add a message or send the attached files…'
  return 'Message the agent… (drop files here)'
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

async function saveAttachments(
  projectPath: string,
  files: FileList | File[]
): Promise<{ attachments: PendingAttachment[]; error: string | null }> {
  const attachments: PendingAttachment[] = []
  const failed: string[] = []
  for (const file of Array.from(files)) {
    try {
      const path = await window.farol.project.saveAttachment(
        projectPath,
        file.name,
        await file.arrayBuffer()
      )
      if (!path) {
        failed.push(file.name)
        continue
      }
      attachments.push({ name: file.name, path, type: file.type })
    } catch {
      failed.push(file.name)
    }
  }
  return { attachments, error: failed.length ? `Could not attach: ${failed.join(', ')}.` : null }
}

function composerSurfaceStyle(dragOver: boolean): React.CSSProperties {
  return {
    maxWidth: 680,
    margin: '0 auto',
    background: dragOver ? C.panel : C.card,
    border: dragOver ? `1px solid ${C.accent}` : `1px solid ${C.cardBorder}`,
    borderRadius: 12,
    padding: '14px 16px 11px',
    position: 'relative',
    boxShadow: dragOver ? '0 0 0 1px rgba(214, 242, 58,.2)' : 'none'
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
  const block = `Attached files:\n${lines}`
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

export function ChatModeSwitch({
  mode,
  provider,
  locked,
  onChange
}: {
  mode: AgentMode
  provider: AiProvider
  locked: boolean
  onChange: (mode: AgentMode) => void
}) {
  const planAvailable = hasReviewGate(provider)
  const unavailablePlanTitle = `${AI_LABELS[provider]}: Cannot enforce read-only`
  return (
    <div
      role="group"
      aria-label="Chat mode"
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: 2,
        gap: 2,
        borderRadius: 8,
        background: C.panel,
        border: `1px solid ${C.cardBorder}`
      }}
    >
      <button
        type="button"
        className="bf-focus"
        disabled={locked || !planAvailable}
        onClick={() => onChange('plan')}
        title={planAvailable ? 'Plan without making changes' : unavailablePlanTitle}
        aria-label={planAvailable ? 'Plan mode' : unavailablePlanTitle}
        aria-pressed={mode === 'plan'}
        style={{
          border: 'none', borderRadius: 6, padding: '3px 7px',
          background: mode === 'plan' ? C.card : 'transparent',
          color: !planAvailable ? C.faint : mode === 'plan' ? C.text : C.textMuted,
          fontSize: 11, fontWeight: 600, cursor: locked || !planAvailable ? 'default' : 'pointer'
        }}
      >
        Plan
      </button>
      <button
        type="button"
        className="bf-focus"
        disabled={locked}
        onClick={() => onChange('build')}
        title="Build with file changes"
        aria-pressed={mode === 'build'}
        style={{
          border: 'none', borderRadius: 6, padding: '3px 7px',
          background: mode === 'build' ? C.card : 'transparent', color: mode === 'build' ? C.text : C.textMuted,
          fontSize: 11, fontWeight: 600, cursor: locked ? 'default' : 'pointer'
        }}
      >
        Build
      </button>
    </div>
  )
}

function ComposerToolbar({
  agentBtnRef,
  provider,
  model,
  usage,
  onRefreshUsage,
  mode,
  isBusy,
  modeLocked,
  canSend,
  onOpenAgentMenu,
  onModeChange,
  onOpenMention,
  onAttach,
  onCancel,
  onSend
}: {
  agentBtnRef: React.RefObject<HTMLButtonElement>
  provider: AiProvider
  model?: string
  usage: ProviderUsage[]
  onRefreshUsage: () => void
  mode: AgentMode
  isBusy: boolean
  modeLocked: boolean
  canSend: boolean
  onOpenAgentMenu: () => void
  onModeChange: (mode: AgentMode) => void
  onOpenMention: () => void
  onAttach: () => void
  onCancel: () => void
  onSend: () => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 14, rowGap: 8 }}>
      <ChatModeSwitch mode={mode} provider={provider} locked={modeLocked} onChange={onModeChange} />
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
          color: '#A1A19A',
          fontSize: 12,
          cursor: 'pointer',
          padding: '2px 4px'
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
      <UsageBar usage={usage} provider={provider} onRefresh={onRefreshUsage} />
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
          color: '#A1A19A',
          cursor: 'pointer',
          padding: 2
        }}
      >
        @
      </button>
      <button
        type="button"
        className="bf-focus bf-composer-btn"
        onClick={onAttach}
        title="Attach files"
        aria-label="Attach files"
        style={{
          display: 'grid',
          placeItems: 'center',
          width: 26,
          height: 26,
          border: 'none',
          borderRadius: 6,
          background: 'transparent',
          color: C.textMuted,
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
    <button
      type="button"
      className="bf-focus"
      onClick={() => (isBusy ? onCancel() : onSend())}
      disabled={!isBusy && !canSend}
      title={isBusy ? 'Stop' : 'Send'}
      aria-label={isBusy ? 'Stop the agent' : 'Send message'}
      style={{
        width: 34,
        height: 30,
        borderRadius: 8,
        border: 'none',
        background: isBusy ? C.red : canSend ? C.accent : C.panel,
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
    </button>
  )
}

function ComposerBox({
  projectPath,
  availableCount,
  isBusy,
  modeLocked,
  provider,
  model,
  mode,
  settings,
  usage,
  onRefreshUsage,
  textareaRef,
  onMessage,
  onCancel,
  onProviderChange,
  onModeChange,
  sendTextRef,
  showFade
}: {
  projectPath: string
  availableCount: number
  isBusy: boolean
  modeLocked: boolean
  provider: AiProvider
  model?: string
  mode: AgentMode
  settings?: AppSettings
  usage: ProviderUsage[]
  onRefreshUsage: () => void
  textareaRef: React.RefObject<HTMLTextAreaElement>
  onMessage: (text: string, provider: AiProvider, model: string | undefined, mode: AgentMode) => void
  onCancel: () => void
  onProviderChange: (provider: AiProvider, model?: string) => void
  onModeChange: (mode: AgentMode) => void
  /** Lets the parent fire the same send path suggestions used before (incl. history). */
  sendTextRef: React.MutableRefObject<(clean: string) => void>
  showFade: boolean
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [savingAttachments, setSavingAttachments] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [agentMenuPos, setAgentMenuPos] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [mentionFiles, setMentionFiles] = useState<string[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [skillQuery, setSkillQuery] = useState<string | null>(null)
  const [skillIndex, setSkillIndex] = useState(0)
  const [skillWarning, setSkillWarning] = useState<string[]>([])
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const composerBoxRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const agentBtnRef = useRef<HTMLButtonElement>(null)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef<number | null>(null)
  const draftRef = useRef('')
  const skillsRef = useRef<AgentSkill[]>([])
  const providerRef = useRef(provider)
  const skillHits = skillQuery !== null ? filterSkills(skills, skillQuery) : []
  const skillWarnText = skillWarningLine(skillWarning, provider)

  const canSend =
    (!!text.trim() || attachments.length > 0) &&
    (availableCount > 0 || mode === 'plan') &&
    savingAttachments === 0

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
    // Allow switching while busy so a usage/session limit can be escaped without
    // waiting for the dying CLI to exit — the next message uses the new provider.
    const r = agentBtnRef.current?.getBoundingClientRect()
    if (r) {
      setAgentMenuPos({
        left: Math.min(Math.max(8, r.right - 188), window.innerWidth - 196),
        bottom: window.innerHeight - r.top + 6,
        maxHeight: Math.max(96, r.top - 12)
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
    onMessage(clean, provider, model, mode)
    const history = historyRef.current
    if (history[history.length - 1] !== clean) history.push(clean)
    if (history.length > 100) history.splice(0, history.length - 100)
    historyIndexRef.current = null
    draftRef.current = ''
  }
  sendTextRef.current = sendText

  const addFiles = (files: FileList | File[]): void => {
    if (!files.length) return
    setAttachmentError(null)
    setSavingAttachments((count) => count + 1)
    void saveAttachments(projectPath, files)
      .then((result) => {
        setAttachmentError(result.error)
        if (result.attachments.length) setAttachments((prev) => [...prev, ...result.attachments])
      })
      .finally(() => setSavingAttachments((count) => count - 1))
  }

  const removeAttachment = (path: string): void => {
    setAttachments((prev) => prev.filter((attachment) => attachment.path !== path))
  }

  const send = (): void => {
    if (!canSend) return
    const paths = attachments.map((attachment) => attachment.path)
    const clean = buildMessage(text, paths)
    if (!clean) return
    sendText(clean)
    setText('')
    setMention(null)
    setSkillQuery(null)
    setSkillWarning([])
    setAttachments([])
  }

  const picker =
    skillQuery !== null
      ? pickerHandle(skillHits, skillIndex, setSkillIndex, () => setSkillQuery(null), insertSkill)
      : mention
        ? pickerHandle(mentionFiles, mentionIndex, setMentionIndex, () => setMention(null), insertMention)
        : null

  return (
    <div
      style={{
        flex: 'none',
        position: 'relative',
        zIndex: 2,
        padding: '28px clamp(16px, 4vw, 34px) 20px',
        background: C.terminal
      }}
    >
      <div className={showFade ? 'bf-chat-fade is-on' : 'bf-chat-fade'} aria-hidden="true" />
      <TodoList
        key={projectPath}
        projectPath={projectPath}
        onRun={sendText}
        canRun={!isBusy && (availableCount > 0 || mode === 'plan')}
      />
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
          addFiles(e.dataTransfer.files)
        }}
        style={composerSurfaceStyle(dragOver)}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.currentTarget.files) addFiles(e.currentTarget.files)
            e.currentTarget.value = ''
          }}
        />
        {attachments.length > 0 && (
          <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
        )}
        {attachmentError && (
          <div role="alert" style={{ fontSize: 12, color: C.red, marginBottom: 8, overflowWrap: 'anywhere' }}>
            {attachmentError}
          </div>
        )}
        {skillWarnText && (
          <div style={{ fontSize: 12, color: '#EF4444', marginBottom: 8 }}>{skillWarnText}</div>
        )}
        {savingAttachments > 0 && (
          <div role="status" style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>
            Saving attachment…
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          aria-label="Message the agent"
          onPaste={(e) => {
            if (!e.clipboardData.files.length) return
            e.preventDefault()
            addFiles(e.clipboardData.files)
          }}
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
          placeholder={composerPlaceholder(availableCount, attachments.length > 0, mode)}
          disabled={!availableCount && mode === 'build'}
          rows={1}
          style={COMPOSER_TEXTAREA_STYLE}
        />
        <ComposerToolbar
          agentBtnRef={agentBtnRef}
          provider={provider}
          model={model}
          usage={usage}
          onRefreshUsage={onRefreshUsage}
          mode={mode}
          isBusy={isBusy}
          modeLocked={modeLocked}
          canSend={canSend}
          onModeChange={onModeChange}
          onOpenAgentMenu={openAgentMenu}
          onOpenMention={openMentionPicker}
          onAttach={() => fileInputRef.current?.click()}
          onCancel={onCancel}
          onSend={send}
        />
      </div>

      {skillQuery !== null && menuPos && (
        <ComposerPickerMenu
          label="Skills"
          menuPos={menuPos}
          empty={skillQuery ? 'No matching skills' : 'No skills found'}
          items={skillHits.map((item) => ({ key: item.name, label: item.name }))}
          index={skillIndex}
          onHover={setSkillIndex}
          onPick={(i) => {
            const item = skillHits[i]
            if (item) insertSkill(item)
          }}
        />
      )}
      {mention && menuPos && (
        <ComposerPickerMenu
          label="Files"
          menuPos={menuPos}
          empty={mention.query ? 'No matching files' : 'Type to filter project files…'}
          items={mentionFiles.map((file) => ({ key: file, label: `@${file}` }))}
          index={mentionIndex}
          onHover={setMentionIndex}
          onPick={(i) => {
            const file = mentionFiles[i]
            if (file) insertMention(file)
          }}
        />
      )}
      {modelOpen && agentMenuPos && (
        <CliModelMenu
          provider={provider}
          model={model}
          settings={settings}
          pos={{ ...agentMenuPos, width: 188 }}
          onPick={(p, m) => {
            onProviderChange(p, m)
            setModelOpen(false)
            window.setTimeout(() => textareaRef.current?.focus(), 0)
          }}
          onClose={() => setModelOpen(false)}
        />
      )}
    </div>
  )
}

export default function ChatPane({
  pane,
  pipelines,
  view,
  projectPath,
  defaultProvider,
  defaultModel,
  settings,
  usage,
  onRefreshUsage,
  onMessage,
  onAnswer,
  onCancel,
  onProviderChange,
  onModeChange,
  onExecutePlan,
  onOpenPipeline,
  onNewChat,
  clearChatConfirm,
  onConfirmClearChat,
  onCancelClearChat,
  chatClearedNotice,
  onDismissChatCleared,
  composerRef
}: Props) {
  const provider = normalizeAi(pane ? pane.provider : defaultProvider)
  const model = normalizeModel(pane ? pane.model : defaultModel)
  const [showFade, setShowFade] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  const syncScrollChrome = (node: HTMLDivElement): void => {
    const room = node.scrollHeight - node.clientHeight
    const fromBottom = room - node.scrollTop
    stickRef.current = fromBottom < STICK_SLACK
    setShowFade(room > 8 && fromBottom > 24)
  }
  const localRef = useRef<HTMLTextAreaElement>(null)
  const textareaRef = composerRef ?? localRef
  const sendTextRef = useRef<(clean: string) => void>(() => {})

  const status = pane?.status ?? 'idle'
  const mode = pane?.mode ?? 'build'
  const isBusy = busy.has(status)
  const modeLocked = isBusy || status === 'asking'
  const messages = pane?.messages ?? []
  const availableCount = pipelines.filter((p) => p.nodes.length).length
  const showSuggestions = availableCount > 0 && mode === 'build'

  // Follow the stream only while the reader is already at the bottom, so
  // scrolling up to read something does not get yanked back by the next event.
  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    if (stickRef.current) node.scrollTop = node.scrollHeight
    syncScrollChrome(node)
    const ro = new ResizeObserver(() => syncScrollChrome(node))
    ro.observe(node)
    if (node.firstElementChild) ro.observe(node.firstElementChild)
    return () => ro.disconnect()
  }, [messages])

  const flex = view === 'split' ? '1 1 50%' : '1 1 100%'

  return (
    <div style={{ ...PANE, flex }}>
      {clearChatConfirm && (
        <ClearChatBanner
          onCancelClearChat={onCancelClearChat}
          onConfirmClearChat={onConfirmClearChat}
        />
      )}
      {chatClearedNotice && messages.length === 0 && (
        <ChatClearedBanner onDismissChatCleared={onDismissChatCleared} />
      )}
      <div
        ref={scrollRef}
        className="bf-chat-scroll"
        onScroll={(e) => syncScrollChrome(e.currentTarget)}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <div
          style={{
            maxWidth: 680,
            margin: '0 auto',
            width: '100%',
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          {messages.length === 0 ? (
            <>
              <ChatGreeting availableCount={availableCount} mode={mode} />
              <div style={{ flex: 1, minHeight: 24 }} />
              {showSuggestions && <SuggestionList onPick={(p) => sendTextRef.current(p)} />}
            </>
          ) : (
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
                    canExecutePlan={!!m.plan?.finished && !m.plan.consumed && !isBusy}
                    onExecutePlan={onExecutePlan}
                  />
                </MessageErrorBoundary>
              ))}
            </div>
          )}
        </div>
      </div>

      <ComposerBox
        projectPath={projectPath}
        availableCount={availableCount}
        isBusy={isBusy}
        modeLocked={modeLocked}
        provider={provider}
        model={model}
        mode={mode}
        settings={settings}
        usage={usage}
        onRefreshUsage={onRefreshUsage}
        textareaRef={textareaRef}
        onMessage={onMessage}
        onCancel={onCancel}
        onProviderChange={onProviderChange}
        onModeChange={onModeChange}
        sendTextRef={sendTextRef}
        showFade={showFade}
      />
    </div>
  )
}
