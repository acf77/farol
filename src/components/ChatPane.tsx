import { useEffect, useRef, useState } from 'react'
import type { AiProvider, Pipeline } from '@shared/types'
import { AI_LABELS, AI_PROVIDERS } from '@shared/ai'
import type { AgentMessage, AgentPane, View } from '../types'
import { C, MONO, PANE } from '../theme'
import { MarkdownBody, stripControlMarkers } from '../markdown'
import {
  CheckIcon,
  ChevronDown,
  CircleIcon,
  ClipIcon,
  CopyIcon,
  RetryIcon,
  SendIcon,
  Sparkle,
  SparkleLarge,
  Spinner,
  ThumbIcon,
  ToolIcon
} from './icons'

interface Props {
  pane: AgentPane | null
  pipelines: Pipeline[]
  view: View
  projectPath: string
  /** Settings default used when no chat pane exists yet. */
  defaultProvider: AiProvider
  onMessage: (text: string) => void
  onCancel: () => void
  onProviderChange: (provider: AiProvider) => void
  onOpenPipeline: (tabId: string) => void
  onNewChat: () => void
  /** Focus hook so ⌘K can put the caret in the composer. */
  composerRef?: React.RefObject<HTMLTextAreaElement>
}

const busy = new Set(['working', 'validating', 'repairing'])

/** How far off the bottom still counts as "following the stream", in px. */
const STICK_SLACK = 80

const SUGGESTIONS = [
  { title: 'Run every pipeline', body: 'Run every available validation pipeline before I open a PR' },
  { title: 'Explain a pipeline', body: 'Walk me through what the selected pipeline checks and why' },
  { title: 'Debug a failure', body: 'Investigate why the last run failed and suggest a fix' }
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

/** The agent's 28px sparkle avatar, left of every assistant turn. */
function AgentMark() {
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: '50%',
        flex: 'none',
        background: '#1b222e',
        display: 'grid',
        placeItems: 'center'
      }}
    >
      <Sparkle />
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
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        minWidth: 0,
        padding: '7px 11px',
        marginLeft: 41,
        // Close the transcript's 26px turn gap when cards run back to back.
        marginTop: tight ? -16 : 0,
        background: '#12171f',
        border: '1px solid #212938',
        borderRadius: 9
      }}
    >
      <ToolIcon />
      <span style={{ fontFamily: MONO, fontSize: 11.5, color: '#c3cad6', flex: 'none' }}>
        {tool.name}
      </span>
      {tool.detail && (
        <span
          title={tool.detail}
          style={{
            fontFamily: MONO,
            fontSize: 11.5,
            color: '#7f889a',
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

function UserMark() {
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: '50%',
        flex: 'none',
        background: 'linear-gradient(150deg,#5b7fb5,#2f4160)',
        border: '1px solid #3d4a63'
      }}
    />
  )
}

export default function ChatPane({
  pane,
  pipelines,
  view,
  projectPath,
  defaultProvider,
  onMessage,
  onCancel,
  onProviderChange,
  onOpenPipeline,
  onNewChat,
  composerRef
}: Props) {
  const [text, setText] = useState('')
  const [modelOpen, setModelOpen] = useState(false)
  const [agentMenuPos, setAgentMenuPos] = useState<{ left: number; bottom: number } | null>(null)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [mentionFiles, setMentionFiles] = useState<string[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const localRef = useRef<HTMLTextAreaElement>(null)
  const textareaRef = composerRef ?? localRef
  const composerBoxRef = useRef<HTMLDivElement>(null)
  const agentBtnRef = useRef<HTMLButtonElement>(null)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef<number | null>(null)
  const draftRef = useRef('')

  const status = pane?.status ?? 'idle'
  const isBusy = busy.has(status)
  // Allow switching while busy so a usage/session limit can be escaped without
  // waiting for the dying CLI to exit — the next message uses the new provider.
  const canChangeProvider = true
  const messages = pane?.messages ?? []
  const availableCount = pipelines.filter((p) => p.nodes.length).length
  const canSend = !!text.trim() && availableCount > 0
  const provider = pane?.provider ?? defaultProvider
  const showSuggestions = messages.length < 3 && availableCount > 0

  // Follow the stream only while the reader is already at the bottom, so
  // scrolling up to read something does not get yanked back by the next event.
  useEffect(() => {
    const node = scrollRef.current
    if (node && stickRef.current) node.scrollTop = node.scrollHeight
  }, [messages])

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
    void window.buildflow.project.listFiles(projectPath, mention.query).then((files) => {
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
        left: Math.min(Math.max(8, r.right - 168), window.innerWidth - 176),
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
    onMessage(clean)
    const history = historyRef.current
    if (history[history.length - 1] !== clean) history.push(clean)
    historyIndexRef.current = null
    draftRef.current = ''
  }

  const send = (): void => {
    const clean = text.trim()
    if (!clean) return
    sendText(clean)
    setText('')
    setMention(null)
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
    <div style={{ ...PANE, flex: view === 'split' ? '1 1 50%' : '1 1 100%', overflow: 'visible' }}>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const node = e.currentTarget
          stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_SLACK
        }}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '40px 34px 8px' }}
      >
        <div style={{ maxWidth: 680, margin: '0 auto' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
            <SparkleLarge />
            <div style={{ fontSize: 29, fontWeight: 500, letterSpacing: '-0.4px', marginTop: 18 }}>
              {greetingFor(new Date())}
            </div>
            <div style={{ fontSize: 15, color: '#8d96a5', marginTop: 8 }}>
              {availableCount
                ? 'How can I help you build today?'
                : 'Create a validation pipeline to start a chat.'}
            </div>
          </div>

          {showSuggestions && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: view === 'split' ? '1fr' : 'repeat(3,1fr)',
                gap: 14,
                marginTop: 34
              }}
            >
              {SUGGESTIONS.map((s) => (
                <div
                  key={s.title}
                  className="bf-suggest"
                  onClick={() => sendText(s.body)}
                  style={{
                    padding: '16px 16px 18px',
                    background: '#141922',
                    border: '1px solid #232a38',
                    borderRadius: 12,
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 7 }}>{s.title}</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.45, color: '#868f9e', textWrap: 'pretty' }}>
                    {s.body}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 26, marginTop: 40 }}>
            {messages.map((m, i) => {
              if (m.role === 'user') {
                return (
                  <div
                    key={i}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 7 }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
                      <div
                        style={{
                          maxWidth: 430,
                          padding: '11px 15px',
                          background: '#1d2637',
                          border: '1px solid #2a3446',
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
                      <UserMark />
                    </div>
                    {m.at && (
                      <span style={{ fontSize: 11, color: '#6d7686', marginRight: 39 }}>
                        {fmtClock(m.at)}
                      </span>
                    )}
                  </div>
                )
              }

              // Tool cards sit in the text column with no avatar, so a burst
              // of them reads as one list rather than a stack of turns.
              if (m.tool) return <ToolCard key={i} tool={m.tool} tight={!!messages[i - 1]?.tool} />

              const pc = m.pipeline
              return (
                <div key={i} style={{ display: 'flex', gap: 13, alignItems: 'flex-start' }}>
                  <AgentMark />
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 15 }}>
                    {pc ? (
                      <div
                        style={{
                          border: '1px solid #242c3b',
                          borderRadius: 11,
                          overflow: 'hidden',
                          background: '#12171f'
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '11px 14px',
                            borderBottom: '1px solid #212938'
                          }}
                        >
                          <ToolIcon />
                          <span style={{ fontFamily: MONO, fontSize: 12, color: '#c3cad6' }}>
                            pipeline: {pc.pipelineName}
                          </span>
                          {pc.status === 'running' ? (
                            <Spinner />
                          ) : pc.status === 'passed' ? (
                            <CheckIcon />
                          ) : (
                            <span style={{ fontSize: 12, fontWeight: 700, color: pc.status === 'failed' ? C.red : C.faint }}>
                              {pc.status === 'failed' ? '✗' : '–'}
                            </span>
                          )}
                          <span style={{ flex: 1 }} />
                          <span
                            className="bf-linkish"
                            onClick={() => onOpenPipeline(pc.tabId)}
                            style={{ fontSize: 11.5, color: '#7f889a', cursor: 'pointer' }}
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
                            color: '#8b94a3',
                            userSelect: 'text'
                          }}
                        >
                          {m.text}
                        </div>
                      </div>
                    ) : m.role === 'assistant' ? (
                      <MarkdownBody text={m.text} />
                    ) : (
                      <div
                        style={{
                          fontSize: 13.5,
                          lineHeight: 1.6,
                          color: '#8b94a3',
                          textWrap: 'pretty',
                          whiteSpace: 'pre-wrap',
                          overflowWrap: 'anywhere',
                          userSelect: 'text'
                        }}
                      >
                        {m.text}
                      </div>
                    )}

                    {/* The footer row belongs to the last assistant turn once it settles. */}
                    {m.role === 'assistant' && i === messages.length - 1 && !isBusy && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#7f889a' }}>
                        <CircleIcon />
                        <span style={{ fontSize: 12 }}>{AI_LABELS[provider]}</span>
                        <span style={{ flex: 1 }} />
                        <div style={{ display: 'flex', gap: 16 }}>
                          <span
                            title="Copy"
                            onClick={() =>
                              void navigator.clipboard?.writeText(stripControlMarkers(m.text))
                            }
                          >
                            <CopyIcon />
                          </span>
                          <span title="Good response">
                            <ThumbIcon />
                          </span>
                          <span title="New chat" onClick={onNewChat}>
                            <RetryIcon />
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{ height: 12 }} />
        </div>
      </div>

      <div style={{ flex: 'none', padding: '8px 34px 20px' }}>
        <div
          ref={composerBoxRef}
          style={{
            maxWidth: 680,
            margin: '0 auto',
            background: '#141922',
            border: '1px solid #262e3d',
            borderRadius: 14,
            padding: '14px 16px 11px',
            position: 'relative'
          }}
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              const value = e.target.value
              setText(value)
              syncMentionFromValue(value, e.target.selectionStart)
            }}
            onKeyDown={(e) => {
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
            }}
            placeholder={availableCount ? 'Message the agent…' : 'Create a validation pipeline to start'}
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
            <div
              className="bf-composer-btn"
              onClick={onNewChat}
              title="New chat"
              style={{
                width: 26,
                height: 26,
                borderRadius: 8,
                background: '#1d2431',
                display: 'grid',
                placeItems: 'center',
                color: '#9aa3b2',
                fontSize: 15,
                cursor: 'pointer'
              }}
            >
              +
            </div>
            <span style={{ flex: 1 }} />
            <button
              ref={agentBtnRef}
              type="button"
              className="bf-focus"
              onClick={openAgentMenu}
              title={`Agent: ${AI_LABELS[provider]}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                border: 'none',
                background: 'transparent',
                color: '#9aa3b2',
                fontSize: 12,
                cursor: canChangeProvider ? 'pointer' : 'default',
                padding: '2px 4px',
                opacity: canChangeProvider ? 1 : 0.55
              }}
            >
              <span>{AI_LABELS[provider]}</span>
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
                color: '#9aa3b2',
                cursor: 'pointer',
                padding: 2
              }}
            >
              <ClipIcon />
            </button>
            <div
              onClick={() => (isBusy ? onCancel() : send())}
              title={isBusy ? 'Stop' : 'Send'}
              style={{
                width: 34,
                height: 30,
                borderRadius: 9,
                background: isBusy ? C.red : canSend ? C.accent : '#1d2431',
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
          </div>
        </div>

          {mention && menuPos && (
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
                background: '#111621',
                border: `1px solid ${C.cardBorder}`,
                borderRadius: 10,
                boxShadow: '0 14px 36px rgba(0,0,0,0.5)',
                padding: 4
              }}
            >
              {!mentionFiles.length ? (
                <div style={{ padding: '10px 12px', fontSize: 12, color: C.textMuted }}>
                  {mention.query ? 'No matching files' : 'Type to filter project files…'}
                </div>
              ) : (
                mentionFiles.map((file, i) => (
                  <button
                    key={file}
                    type="button"
                    role="option"
                    aria-selected={i === mentionIndex}
                    className="bf-focus bf-menu-item"
                    onMouseEnter={() => setMentionIndex(i)}
                    onClick={() => insertMention(file)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      border: 'none',
                      background: i === mentionIndex ? '#1b2433' : 'transparent',
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
          )}

          {modelOpen && agentMenuPos && canChangeProvider && (
            <>
              <div
                aria-hidden
                onMouseDown={(e) => {
                  e.preventDefault()
                  setModelOpen(false)
                }}
                style={{ position: 'fixed', inset: 0, zIndex: 65 }}
              />
              <div
                role="menu"
                aria-label="Agent"
                onMouseDown={(e) => e.preventDefault()}
                style={{
                  position: 'fixed',
                  left: agentMenuPos.left,
                  bottom: agentMenuPos.bottom,
                  zIndex: 70,
                  width: 168,
                  background: '#111621',
                  border: `1px solid ${C.cardBorder}`,
                  borderRadius: 10,
                  boxShadow: '0 14px 36px rgba(0,0,0,0.5)',
                  padding: 4
                }}
              >
                {AI_PROVIDERS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="menuitem"
                    className="bf-focus bf-menu-item"
                    onClick={() => {
                      onProviderChange(p)
                      setModelOpen(false)
                      window.setTimeout(() => textareaRef.current?.focus(), 0)
                    }}
                    style={{
                      display: 'flex',
                      width: '100%',
                      justifyContent: 'space-between',
                      border: 'none',
                      background: 'transparent',
                      color: p === provider ? C.textStrong : C.textMuted,
                      cursor: 'pointer'
                    }}
                  >
                    <span>{AI_LABELS[p]}</span>
                    {p === provider && <CheckIcon size={12} />}
                  </button>
                ))}
              </div>
            </>
          )}
      </div>
    </div>
  )
}
