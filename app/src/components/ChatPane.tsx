import { useEffect, useRef, useState } from 'react'
import { AGENT_LIVE, type AgentMode, type AiProvider, type AppSettings, type Pipeline, type ProviderUsage } from '@shared/types'
import { normalizeAi, normalizeModel } from '@shared/ai'
import { contextIsHigh, contextLongLabel, isContextOverflow, type ContextUsage } from '@shared/agent-context'
import type { AgentMessage, AgentPane } from '../types'
import { C, PANE } from '../theme'
import { MessageErrorBoundary } from '../ErrorBoundary'
import { Button } from './controls'
import { CheckIcon, SearchIcon, ToolIcon } from './icons'
import farolMark from '../assets/farol-mark.png'
import { ChatBanner } from './chat/cards'
import { ComposerBox } from './chat/Composer'
import { Turn } from './chat/Turn'

interface Props {
  pane: AgentPane | null
  pipelines: Pipeline[]
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
  /** Continue in a new CLI session seeded with the agent's handoff note. */
  onFreshStart?: () => void
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

/**
 * Blocks the whole chat behind a dimmed, transparent scrim so the confirmation
 * can't be missed or clicked through by accident — clearing a chat is
 * unrecoverable, so this needs to grab attention rather than sit as a
 * dismissible banner in the scroll flow.
 */
function ClearChatOverlay({
  onCancelClearChat,
  onConfirmClearChat
}: {
  onCancelClearChat?: () => void
  onConfirmClearChat?: () => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement
    cardRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true })
      }
    }
  }, [])

  const trapFocus = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancelClearChat?.()
      return
    }
    if (e.key !== 'Tab') return
    const focusable = cardRef.current?.querySelectorAll<HTMLElement>('button')
    if (!focusable?.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="clear-chat-title"
      aria-describedby="clear-chat-desc"
      onKeyDown={trapFocus}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancelClearChat?.()
      }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 20,
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        boxSizing: 'border-box',
        background: 'rgba(12, 12, 10, 0.55)',
        animation: 'bfOverlayIn 120ms ease-out'
      }}
    >
      <div
        ref={cardRef}
        className="bf-clear-chat-card"
        style={{
          width: '100%',
          maxWidth: 360,
          boxSizing: 'border-box',
          padding: '16px 18px',
          borderRadius: 12,
          background: C.sidebar,
          border: `1px solid ${C.red}`,
          boxShadow: '0 20px 48px rgba(0,0,0,0.5)',
          animation: 'bfOverlayCardIn 140ms ease-out'
        }}
      >
        <div id="clear-chat-title" style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
          Clear this conversation?
        </div>
        <div id="clear-chat-desc" style={{ fontSize: 12, lineHeight: 1.45, color: C.textMuted, marginTop: 6 }}>
          Clearing permanently deletes this branch&apos;s current messages. This can&apos;t be undone.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button onClick={onCancelClearChat}>Cancel</Button>
          <Button
            variant="danger"
            onClick={onConfirmClearChat}
            style={{ background: 'rgba(255, 98, 90,0.16)' }}
          >
            Clear chat
          </Button>
        </div>
      </div>
    </div>
  )
}

function ChatClearedBanner({ onDismissChatCleared }: { onDismissChatCleared?: () => void }) {
  return (
    <ChatBanner role="status">
      <span style={{ flex: 1, fontSize: 12, lineHeight: 1.45, color: C.textMuted }}>
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

/**
 * Why a fresh start is suggested — a large reading, or the agent stopped on
 * its context limit — and a key that changes only when the situation does
 * (a new stop, or the next 10% band), so a dismissal holds until then.
 */
export function freshStartReason(
  usage: ContextUsage | undefined,
  messages: AgentMessage[]
): { text: string; key: string } | null {
  const last = messages[messages.length - 1]
  if (last?.role === 'system' && isContextOverflow(last.text)) {
    return { text: 'The agent ran out of context.', key: `overflow:${messages.length}` }
  }
  if (!usage || !contextIsHigh(usage)) return null
  const band = usage.window ? Math.floor((usage.tokens / usage.window) * 10) : Math.floor(usage.tokens / 50_000)
  return { text: `Context is large (${contextLongLabel(usage)}).`, key: `high:${band}` }
}

function FreshStartBanner({
  reason,
  isBusy,
  onFreshStart,
  onDismiss
}: {
  reason: string
  isBusy: boolean
  onFreshStart: () => void
  onDismiss: () => void
}) {
  return (
    <ChatBanner role="status" style={{ borderColor: C.yellowDim }}>
      <span style={{ flex: 1, fontSize: 12, lineHeight: 1.45, color: C.textMuted }}>
        <span style={{ color: C.yellow }}>{reason}</span> Answers get less precise as it grows. Fresh
        start keeps this chat and continues in a new session from the agent&apos;s handoff note.
      </span>
      <Button
        disabled={isBusy}
        title={isBusy ? 'Available when the agent finishes' : 'Write a handoff note and start a new session'}
        onClick={onFreshStart}
      >
        Fresh start
      </Button>
      <button
        type="button"
        className="bf-focus"
        onClick={onDismiss}
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
        style={{ borderRadius: 8, display: 'block' }}
      />
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: '-0.4px',
          marginTop: 18,
          color: C.text
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
            background: C.sidebar,
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            cursor: 'pointer',
            textAlign: 'left',
            color: C.text,
            fontFamily: 'inherit'
          }}
        >
          <span style={{ color: C.textMuted, display: 'grid' }}>
            <Icon size={16} color={C.textMuted} />
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

export default function ChatPane({
  pane,
  pipelines,
  projectPath,
  defaultProvider,
  defaultModel,
  settings,
  usage,
  onRefreshUsage,
  onMessage,
  onAnswer,
  onCancel,
  onFreshStart,
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
  const isBusy = AGENT_LIVE.has(status)
  const modeLocked = isBusy || status === 'asking'
  const messages = pane?.messages ?? []
  const availableCount = pipelines.filter((p) => p.nodes.length).length
  const showSuggestions = availableCount > 0 && mode === 'build'
  const freshReason = onFreshStart ? freshStartReason(pane?.usage, messages) : null
  // Dismissed for this reason until the reading changes band or the chat changes.
  const freshKey = `${pane?.taskId ?? ''}:${freshReason?.key ?? ''}`
  const [dismissedFresh, setDismissedFresh] = useState<string | null>(null)

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

  return (
    <div style={{ ...PANE, flex: '1 1 100%', position: 'relative' }}>
      {clearChatConfirm && (
        <ClearChatOverlay
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

      {freshReason && onFreshStart && dismissedFresh !== freshKey && (
        <FreshStartBanner
          reason={freshReason.text}
          isBusy={isBusy || status === 'asking'}
          onFreshStart={onFreshStart}
          onDismiss={() => setDismissedFresh(freshKey)}
        />
      )}
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
        contextUsage={pane?.usage}
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
