import { useEffect, useRef, useState } from 'react'
import type { AgentMode, AgentSkill, AiProvider, AppSettings, ProviderUsage } from '@shared/types'
import { aiSelectionLabel } from '@shared/ai'
import {
  convertSkillDraft,
  filterSkills,
  insertSkillText,
  retainSkillWarning,
  skillMenuQuery,
  skillWarningLine
} from '@shared/skills'
import {
  contextIsHigh,
  contextLongLabel,
  contextShortLabel,
  type ContextUsage
} from '@shared/agent-context'
import { C, MONO } from '../../theme'
import { CLI_MODEL_MENU_WIDTH, CliModelMenu } from '../controls'
import UsageBar from '../UsageBar'
import TodoList from '../TodoList'
import {
  AttachmentIcon,
  ChevronDown,
  ClipIcon,
  SendIcon
} from '../icons'

interface PendingAttachment {
  name: string
  path: string
  type: string
}

function ContextMeter({ usage }: { usage?: ContextUsage }) {
  if (!usage) return null
  const high = contextIsHigh(usage)
  return (
    <span
      role="status"
      title={`Context: ${contextLongLabel(usage)} at the agent's latest step${high ? ' — consider a fresh start' : ''}`}
      style={{
        fontFamily: MONO,
        fontSize: 11,
        color: high ? C.yellow : C.faint,
        whiteSpace: 'nowrap'
      }}
    >
      ctx {contextShortLabel(usage)}
      {high ? ' !' : ''}
    </span>
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
              border: `1px solid ${C.border}`,
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
                  fontSize: 12,
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
        background: C.sidebar,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
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
    background: dragOver ? C.panel : C.sidebar,
    border: dragOver ? `1px solid ${C.accent}` : `1px solid ${C.border}`,
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
  fontSize: 13,
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
  locked,
  onChange
}: {
  mode: AgentMode
  locked: boolean
  onChange: (mode: AgentMode) => void
}) {
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
        border: `1px solid ${C.border}`
      }}
    >
      <button
        type="button"
        className="bf-focus"
        disabled={locked}
        onClick={() => onChange('plan')}
        title="Plan without making changes"
        aria-pressed={mode === 'plan'}
        style={{
          border: 'none', borderRadius: 6, padding: '3px 7px',
          background: mode === 'plan' ? C.sidebar : 'transparent',
          color: mode === 'plan' ? C.text : C.textMuted,
          fontSize: 11, fontWeight: 600, cursor: locked ? 'default' : 'pointer'
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
          background: mode === 'build' ? C.sidebar : 'transparent', color: mode === 'build' ? C.text : C.textMuted,
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
  contextUsage,
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
  contextUsage?: ContextUsage
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
      <ChatModeSwitch mode={mode} locked={modeLocked} onChange={onModeChange} />
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
          color: C.textMuted,
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
      <ContextMeter usage={contextUsage} />
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
          color: C.textMuted,
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
        <span style={{ width: 10, height: 10, borderRadius: 4, background: '#fff' }} />
      ) : (
        <SendIcon />
      )}
    </button>
  )
}

export function ComposerBox({
  projectPath,
  availableCount,
  isBusy,
  modeLocked,
  provider,
  model,
  mode,
  settings,
  usage,
  contextUsage,
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
  contextUsage?: ContextUsage
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
        left: Math.min(Math.max(8, r.right - CLI_MODEL_MENU_WIDTH), window.innerWidth - CLI_MODEL_MENU_WIDTH - 8),
        bottom: window.innerHeight - r.top + 6,
        maxHeight: Math.max(220, r.top - 12)
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
          contextUsage={contextUsage}
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
          pos={{ ...agentMenuPos, width: CLI_MODEL_MENU_WIDTH }}
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
