import {
  hasControlMarker,
  isQuestionToolName,
  questionsFromToolInput,
  type AgentQuestion
} from './questions'
import { isCodexHookTrustWarning } from './codex-hook'

/**
 * Turning a coding CLI's realtime NDJSON stream into chat events.
 *
 * With their default `text` output the managed CLIs print nothing until the
 * whole run is over — the chat sits silent while the agent edits files and
 * shells out. Their `stream-json` modes emit one JSON object per line as work
 * happens, which is what this parser reads.
 *
 * Claude and Cursor share the Anthropic-style `assistant`/`user` envelope;
 * Cursor adds its own `tool_call` events. Codex uses `item.started`,
 * `item.updated`, and `item.completed` lifecycle events around agent messages
 * and tool items. OpenCode (`--format json`) emits
 * `text` / `tool_use` / `error` envelopes with a `part` payload. OMP
 * (`--mode json`) emits `message_end` envelopes plus `tool_execution_*` events.
 * Upstream pi, which OpenRouter can ride, emits the same events as OMP.
 */

/** One complete assistant turn. */
export interface AgentStreamText {
  kind: 'text'
  text: string
}

/** A tool the agent invoked, and how it ended. */
export interface AgentStreamTool {
  kind: 'tool'
  /** Stable across the started/finished pair so the UI updates one card. */
  toolId: string
  name: string
  /** The command, path, or pattern — whatever identifies this call. */
  detail?: string
  state: 'running' | 'done' | 'error'
}

/** A question tool — rendered as a chooser, not a generic tool card. */
export interface AgentStreamQuestion {
  kind: 'question'
  toolId: string
  questions: AgentQuestion[]
}

/** A line that was not JSON we understand; shown verbatim. */
export interface AgentStreamRaw {
  kind: 'raw'
  text: string
}

export type AgentStreamEvent = AgentStreamText | AgentStreamTool | AgentStreamQuestion | AgentStreamRaw

/**
 * Codex `item.completed` for a shell can embed the whole `aggregated_output` on
 * one JSONL line (multi‑MB). Cap growth, but keep enough headroom that a normal
 * command result still parses instead of leaking into the transcript as raw JSON.
 */
const MAX_LINE = 8_000_000
/** Only the leading bytes are needed to recover id / type / command. */
const RECOVER_PREFIX = 8_000
const MAX_DETAIL = 160

/** Input keys worth showing, most identifying first. */
const DETAIL_KEYS = [
  'command',
  'file_path',
  'filePath',
  'path',
  'pattern',
  'url',
  'query',
  'description',
  'prompt'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Ids are only ever compared and used as React keys; whitespace is noise. */
function normalizeId(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : fallback
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat
}

/** The one field of a tool's input that tells a person what it is doing. */
export function toolDetail(input: unknown): string | undefined {
  if (typeof input === 'string') return truncate(input) || undefined
  if (!isRecord(input)) return undefined
  for (const key of DETAIL_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return truncate(value)
  }
  return undefined
}

/** `shellToolCall` -> `shell`; Cursor names the tool with the wrapper key. */
function cursorToolName(key: string): string {
  return key.replace(/ToolCall$/, '') || key
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function codexItemType(item: Record<string, unknown>): string {
  return String(item.type ?? '').replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

function codexState(item: Record<string, unknown>, completed: boolean): AgentStreamTool['state'] {
  if (!completed) return 'running'
  const status = String(item.status ?? '').toLowerCase().replace(/[_-]/g, '')
  const exitCode = item.exit_code ?? item.exitCode
  if (
    status === 'failed' ||
    status === 'error' ||
    status === 'declined' ||
    item.error ||
    (typeof exitCode === 'number' && exitCode !== 0)
  ) {
    return 'error'
  }
  return 'done'
}

function jsonDetail(value: unknown): string | undefined {
  const direct = toolDetail(value)
  if (direct) return direct
  if (!isRecord(value) && !Array.isArray(value)) return undefined
  try {
    return truncate(JSON.stringify(value)) || undefined
  } catch {
    return undefined
  }
}

/** OpenCode JSONL only emits finished tools — completed vs error. */
function finishedToolState(
  status: string,
  extra?: { exit?: unknown; error?: unknown }
): AgentStreamTool['state'] {
  const normalized = status.toLowerCase()
  if (
    normalized === 'error' ||
    normalized === 'failed' ||
    Boolean(extra?.error) ||
    (typeof extra?.exit === 'number' && extra.exit !== 0)
  ) {
    return 'error'
  }
  return 'done'
}

/** OMP brackets every tool with a start/end pair; `isError` only rides the end. */
function ompToolState(event: Record<string, unknown>): AgentStreamTool['state'] {
  if (event.type !== 'tool_execution_end') return 'running'
  return event.isError === true ? 'error' : 'done'
}

function changedPaths(changes: unknown): string | undefined {
  if (!Array.isArray(changes)) return undefined
  const paths = changes
    .flatMap((change) => (isRecord(change) ? [stringField(change, 'path')] : []))
    .filter((value): value is string => !!value)
  return paths.length ? truncate(paths.join(', ')) : undefined
}

/** Map a Codex item type to the tool card name + detail shown in the stream. */
function codexToolMeta(
  type: string,
  item: Record<string, unknown>
): { name: string; detail?: string } | undefined {
  switch (type) {
    case 'command_execution':
      return { name: 'shell', detail: toolDetail(item) }
    case 'file_change':
      return { name: 'apply_patch', detail: changedPaths(item.changes) }
    case 'mcp_tool_call': {
      const server = stringField(item, 'server')
      const tool = stringField(item, 'tool') ?? 'mcp'
      return { name: server ? `${server}.${tool}` : tool, detail: jsonDetail(item.arguments) }
    }
    case 'web_search':
      return {
        name: 'web_search',
        detail: stringField(item, 'query') ?? jsonDetail(item.action)
      }
    case 'image_view':
      return { name: 'view_image', detail: stringField(item, 'path') }
    case 'dynamic_tool_call':
    case 'collab_tool_call':
      return {
        name: stringField(item, 'tool') ?? type.replace(/_tool_call$/, ''),
        detail: jsonDetail(item.arguments) ?? stringField(item, 'prompt')
      }
    case 'todo_list':
      return { name: 'update_plan' }
    default:
      return undefined
  }
}

/** True when a line looks like provider stream-json, not a human-readable warning. */
function looksLikeStreamJson(text: string): boolean {
  const head = text.trimStart().slice(0, 200)
  return head.startsWith('{') && /"type"\s*:/.test(head)
}

/** Read a JSON string value for `key` from a (possibly truncated) object prefix. */
function peekJsonString(text: string, key: string): string | undefined {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`)
  const match = re.exec(text)
  if (!match) return undefined
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return match[1]
  }
}

/**
 * When a Codex item line is truncated or too large to parse, the identifying
 * fields still sit before `aggregated_output`. Recover a tool card from that
 * prefix so Chat updates the spinner instead of dumping megabytes of JSON.
 */
function recoverCodexItem(text: string): AgentStreamEvent[] {
  const head = text.slice(0, RECOVER_PREFIX)
  const lifecycle = /"type"\s*:\s*"item\.(started|updated|completed)"/.exec(head)
  if (!lifecycle) return []
  const completed = lifecycle[1] === 'completed'
  const itemAt = head.search(/"item"\s*:\s*\{/)
  const itemHead = itemAt >= 0 ? head.slice(itemAt) : head
  const rawType = peekJsonString(itemHead, 'type')
  if (!rawType) return []
  const type = rawType.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
  if (type === 'agent_message') return []
  const meta = codexToolMeta(type, {
    type,
    command: peekJsonString(itemHead, 'command'),
    path: peekJsonString(itemHead, 'path'),
    query: peekJsonString(itemHead, 'query'),
    tool: peekJsonString(itemHead, 'tool'),
    server: peekJsonString(itemHead, 'server')
  })
  if (!meta) return []
  const toolId = normalizeId(peekJsonString(itemHead, 'id'), `codex-${type}`)
  const exitRaw = /"exit_code"\s*:\s*(-?\d+)/.exec(itemHead)?.[1]
  const status = peekJsonString(itemHead, 'status')
  const state = codexState(
    {
      status,
      exit_code: exitRaw !== undefined ? Number(exitRaw) : undefined
    },
    completed
  )
  return [
    {
      kind: 'tool',
      toolId,
      name: meta.name,
      ...(meta.detail ? { detail: meta.detail } : {}),
      state
    }
  ]
}

/**
 * OpenCode packs `part.state.output` onto the same JSONL line as the tool
 * envelope. Recover name / command from the prefix when that line is truncated.
 */
function recoverOpenCodeTool(text: string): AgentStreamEvent[] {
  const head = text.slice(0, RECOVER_PREFIX)
  if (!/"type"\s*:\s*"tool_use"/.test(head)) return []
  const partAt = head.search(/"part"\s*:\s*\{/)
  const partHead = partAt >= 0 ? head.slice(partAt) : head
  const name = peekJsonString(partHead, 'tool') ?? 'tool'
  const detail =
    peekJsonString(partHead, 'command') ??
    peekJsonString(partHead, 'path') ??
    peekJsonString(partHead, 'title')
  const exitRaw = /"exit"\s*:\s*(-?\d+)/.exec(partHead)?.[1]
  return [
    {
      kind: 'tool',
      toolId: normalizeId(
        peekJsonString(partHead, 'callID') ?? peekJsonString(partHead, 'id'),
        `opencode-${name}`
      ),
      name,
      ...(detail ? { detail: truncate(detail) } : {}),
      state: finishedToolState(peekJsonString(partHead, 'status') ?? '', {
        exit: exitRaw !== undefined ? Number(exitRaw) : undefined
      })
    }
  ]
}

/**
 * OMP writes the whole tool result onto its `tool_execution_end` line, so a
 * noisy `bash` can outgrow MAX_LINE. Name and id precede that payload.
 */
function recoverOmpTool(text: string): AgentStreamEvent[] {
  const head = text.slice(0, RECOVER_PREFIX)
  const lifecycle = /"type"\s*:\s*"tool_execution_(start|end)"/.exec(head)
  if (!lifecycle) return []
  const name = peekJsonString(head, 'toolName') ?? 'tool'
  return [
    {
      kind: 'tool',
      toolId: normalizeId(peekJsonString(head, 'toolCallId'), `omp-${name}`),
      name,
      state: lifecycle[1] === 'end' ? 'done' : 'running'
    }
  ]
}

/** Protocol JSON must not land in the transcript — recover a card or drop it. */
function handleBrokenStreamJson(text: string): AgentStreamEvent[] {
  const recovered = recoverCodexItem(text)
  if (recovered.length) return recovered
  const openCode = recoverOpenCodeTool(text)
  return openCode.length ? openCode : recoverOmpTool(text)
}

/**
 * The CLI's own conversation id, for resuming it next turn. Claude and Cursor
 * report `session_id` on their init and result events, Codex a `thread_id`
 * on `thread.started`, and OpenCode a `sessionID` on every event.
 */
function streamSessionId(event: Record<string, unknown>): string | undefined {
  if (event.type === 'thread.started') return stringField(event, 'thread_id')?.trim() || undefined
  if ((event.type === 'system' && event.subtype === 'init') || event.type === 'result') {
    return stringField(event, 'session_id')?.trim() || undefined
  }
  const part = event.part
  const id = stringField(event, 'sessionID') ?? (isRecord(part) ? stringField(part, 'sessionID') : undefined)
  return id?.trim() || undefined
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Tokens the latest model call read — how full the context is now. Claude
 * reports `message.usage` on each top-level assistant message (subagent
 * messages carry a `parent_tool_use_id` and are skipped), OpenCode `tokens`
 * on each finished step, OMP `usage` on each settled message. Codex's
 * per-turn totals add up every call in the turn, and Cursor reports none, so
 * neither gives a reading.
 */
function streamContextTokens(event: Record<string, unknown>): number | undefined {
  if (event.type === 'assistant' && !event.parent_tool_use_id && isRecord(event.message)) {
    const usage = event.message.usage
    if (!isRecord(usage)) return undefined
    const tokens =
      count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens)
    return tokens || undefined
  }
  if (isRecord(event.part) && isRecord(event.part.tokens)) {
    const tokens = event.part.tokens
    const cache = isRecord(tokens.cache) ? tokens.cache : {}
    return count(tokens.input) + count(cache.read) + count(cache.write) || undefined
  }
  if (event.type === 'message_end' && isRecord(event.message) && event.message.role === 'assistant') {
    const usage = event.message.usage
    if (!isRecord(usage)) return undefined
    return count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite) || undefined
  }
  return undefined
}

/** Claude Code's result names each model's window in `modelUsage`. */
function streamContextWindow(event: Record<string, unknown>): number | undefined {
  if (event.type !== 'result' || !isRecord(event.modelUsage)) return undefined
  let window = 0
  for (const entry of Object.values(event.modelUsage)) {
    if (isRecord(entry)) window = Math.max(window, count(entry.contextWindow))
  }
  return window || undefined
}

export class AgentStreamParser {
  /** Set once the stream names the CLI's own conversation. */
  sessionId?: string
  /** Latest context reading; replaced as the run goes on. */
  contextTokens?: number
  contextWindow?: number
  private buffer = ''
  /** tool_use id -> name, so a later tool_result can name the card it closes. */
  private names = new Map<string, string>()
  /** Claude's final `result` event duplicates assistant text; only used for missed markers. */
  private sawControlMarker = false
  /** OMP/pi: the latest settled assistant message ended with `stopReason: 'error'`. */
  private endedInError = false

  /**
   * True when the run's last assistant message failed. Pi exits 0 in
   * `--mode json` even then, so the exit code alone would read as success.
   * A later message (pi's own auto-retry) clears it.
   */
  get failed(): boolean {
    return this.endedInError
  }

  /** Feed raw stdout. Chunks split lines anywhere, so partials are held back. */
  push(chunk: string): AgentStreamEvent[] {
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE && !this.buffer.includes('\n')) {
      const text = this.buffer
      this.buffer = ''
      // Oversized JSONL (Codex shell aggregated_output) — recover the card, never
      // dump the payload into Chat as assistant text.
      if (looksLikeStreamJson(text)) return handleBrokenStreamJson(text)
      return [{ kind: 'raw', text: `${text.slice(0, RECOVER_PREFIX)}…\n` }]
    }
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    return lines.flatMap((line) => this.line(line))
  }

  /** Drain the trailing partial line once the process closes. */
  flush(): AgentStreamEvent[] {
    const rest = this.buffer
    this.buffer = ''
    return rest.trim() ? this.line(rest) : []
  }

  private line(raw: string): AgentStreamEvent[] {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) return []
    if (!line.trimStart().startsWith('{')) return [{ kind: 'raw', text: `${line}\n` }]
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      // Broken / truncated provider JSON must not appear as chat prose.
      if (looksLikeStreamJson(line)) return handleBrokenStreamJson(line)
      return [{ kind: 'raw', text: `${line}\n` }]
    }
    if (!isRecord(value)) return [{ kind: 'raw', text: `${line}\n` }]
    this.sessionId ??= streamSessionId(value)
    this.contextTokens = streamContextTokens(value) ?? this.contextTokens
    this.contextWindow = streamContextWindow(value) ?? this.contextWindow
    return this.event(value)
  }

  private event(event: Record<string, unknown>): AgentStreamEvent[] {
    switch (event.type) {
      case 'assistant':
      case 'user':
        return this.content(event, event.type === 'user' ? 'user' : 'assistant')
      case 'tool_call':
        return this.cursorTool(event)
      case 'text': {
        const part = event.part
        const text = isRecord(part) ? stringField(part, 'text') : undefined
        return text?.trim() ? [{ kind: 'text', text }] : []
      }
      case 'tool_use':
        return this.openCodeTool(event)
      case 'message_end':
        return this.ompMessage(event)
      case 'tool_execution_start':
      case 'tool_execution_end':
        return this.ompTool(event)
      case 'notice':
        return this.ompNotice(event)
      case 'item.started':
      case 'item.updated':
        return this.codexItem(event, false)
      case 'item.completed':
        return this.codexItem(event, true)
      case 'turn.failed':
      case 'error':
        return this.streamError(event)
      case 'result':
        return this.claudeResult(event)
      default:
        return []
    }
  }

  private content(event: Record<string, unknown>, role: 'assistant' | 'user'): AgentStreamEvent[] {
    const message = event.message
    const items = isRecord(message) && Array.isArray(message.content) ? message.content : []
    const out: AgentStreamEvent[] = []
    for (const item of items) {
      if (!isRecord(item)) continue
      const next = this.contentItem(item, role)
      if (next) out.push(next)
    }
    return out
  }

  private contentItem(
    item: Record<string, unknown>,
    role: 'assistant' | 'user'
  ): AgentStreamEvent | undefined {
    if (role === 'assistant') return this.assistantItem(item)
    return this.userToolResult(item)
  }

  private assistantItem(item: Record<string, unknown>): AgentStreamEvent | undefined {
    if (item.type === 'text') {
      const text = typeof item.text === 'string' ? item.text : ''
      if (!text.trim()) return undefined
      if (hasControlMarker(text)) this.sawControlMarker = true
      return { kind: 'text', text }
    }
    if (item.type !== 'tool_use') return undefined
    const toolId = normalizeId(item.id, `tool-${this.names.size}`)
    const name = stringField(item, 'name') ?? 'tool'
    this.names.set(toolId, name)
    const asked = isQuestionToolName(name) ? questionsFromToolInput(item.input) : undefined
    if (asked) return { kind: 'question', toolId, questions: asked }
    return { kind: 'tool', toolId, name, detail: toolDetail(item.input), state: 'running' }
  }

  private userToolResult(item: Record<string, unknown>): AgentStreamEvent | undefined {
    if (item.type !== 'tool_result') return undefined
    const toolId = normalizeId(item.tool_use_id, '')
    if (!toolId) return undefined
    const name = this.names.get(toolId) ?? 'tool'
    if (isQuestionToolName(name)) return undefined
    return { kind: 'tool', toolId, name, state: item.is_error === true ? 'error' : 'done' }
  }

  /** Cursor: `{ type: 'tool_call', subtype, call_id, tool_call: { shellToolCall: { args } } }`. */
  private cursorTool(event: Record<string, unknown>): AgentStreamEvent[] {
    const call = event.tool_call
    if (!isRecord(call)) return []
    const key = Object.keys(call).find((k) => isRecord(call[k]))
    if (!key) return []
    const body = call[key] as Record<string, unknown>
    const toolId = normalizeId(event.call_id, key)
    const name = cursorToolName(key)
    const asked = isQuestionToolName(name) ? questionsFromToolInput(body.args) : undefined
    if (asked) return [{ kind: 'question', toolId, questions: asked }]
    const detail = toolDetail(body.args)
    const subtype = event.subtype
    const state: AgentStreamTool['state'] =
      subtype === 'completed' ? 'done' : subtype === 'error' || subtype === 'failed' ? 'error' : 'running'
    return [{ kind: 'tool', toolId, name, ...(detail ? { detail } : {}), state }]
  }

  /** Codex CLI: `{ type: 'item.started|completed', item: { type, id, ... } }`. */
  private codexItem(event: Record<string, unknown>, completed: boolean): AgentStreamEvent[] {
    const item = event.item
    if (!isRecord(item)) return []
    const type = codexItemType(item)
    if (type === 'agent_message') {
      const text = stringField(item, 'text')
      return completed && text?.trim() ? [{ kind: 'text', text }] : []
    }
    if (type === 'error') return completed ? this.streamError(item) : []

    const meta = codexToolMeta(type, item)
    if (!meta) return []
    const toolId = normalizeId(item.id, `codex-${type || 'tool'}`)
    const asked = isQuestionToolName(meta.name)
      ? questionsFromToolInput(item.arguments ?? item)
      : undefined
    if (asked) return [{ kind: 'question', toolId, questions: asked }]
    const state = codexState(item, completed)
    return [
      {
        kind: 'tool',
        toolId,
        name: meta.name,
        ...(meta.detail ? { detail: meta.detail } : {}),
        state
      }
    ]
  }

  /**
   * OpenCode: `{ type: 'tool_use', part: { callID, tool, state } }`.
   * JSON format only emits completed/error — there is no running spin-up.
   */
  private openCodeTool(event: Record<string, unknown>): AgentStreamEvent[] {
    const part = event.part
    if (!isRecord(part)) return []
    const name = stringField(part, 'tool') ?? 'tool'
    const toolId = normalizeId(part.callID ?? part.id, `opencode-${name}`)
    const body = isRecord(part.state) ? part.state : {}
    const asked = isQuestionToolName(name) ? questionsFromToolInput(body.input) : undefined
    if (asked) return [{ kind: 'question', toolId, questions: asked }]
    const title = stringField(body, 'title')
    const detail = toolDetail(body.input) ?? (title ? truncate(title) : undefined)
    const meta = isRecord(body.metadata) ? body.metadata : {}
    return [
      {
        kind: 'tool',
        toolId,
        name,
        ...(detail ? { detail } : {}),
        state: finishedToolState(String(body.status ?? ''), { exit: meta.exit, error: body.error })
      }
    ]
  }

  /**
   * OMP: `{ type: 'message_end', message }`. Only the settled assistant message
   * is read — `turn_end` repeats it, and `message_update` carries token deltas.
   */
  private ompMessage(event: Record<string, unknown>): AgentStreamEvent[] {
    const message = event.message
    if (!isRecord(message) || message.role !== 'assistant') return []
    this.endedInError = message.stopReason === 'error'
    const content = Array.isArray(message.content) ? message.content : []
    const out: AgentStreamEvent[] = []
    for (const item of content) {
      if (!isRecord(item) || item.type !== 'text') continue
      const text = stringField(item, 'text')
      if (text) out.push({ kind: 'text', text })
    }
    const failure = stringField(message, 'errorMessage')
    if (failure) out.push({ kind: 'raw', text: `${failure}\n` })
    return out
  }

  /** OMP: `{ type: 'tool_execution_start|end', toolCallId, toolName, args }`. */
  private ompTool(event: Record<string, unknown>): AgentStreamEvent[] {
    const name = stringField(event, 'toolName') ?? 'tool'
    const toolId = normalizeId(event.toolCallId, `omp-${name}`)
    const asked = isQuestionToolName(name) ? questionsFromToolInput(event.args) : undefined
    if (asked) return [{ kind: 'question', toolId, questions: asked }]
    // The end event repeats no input; the card keeps the detail it opened with.
    const detail = toolDetail(event.args)
    const state = ompToolState(event)
    return [{ kind: 'tool', toolId, name, ...(detail ? { detail } : {}), state }]
  }

  /** OMP status chatter is routine; only a real failure belongs in Chat. */
  private ompNotice(event: Record<string, unknown>): AgentStreamEvent[] {
    return event.level === 'error' ? this.streamError(event) : []
  }

  /** Claude's `result` duplicates assistant text; emit it only for a missed Farol marker. */
  private claudeResult(event: Record<string, unknown>): AgentStreamEvent[] {
    const text = stringField(event, 'result')
    if (!text?.trim() || this.sawControlMarker || !hasControlMarker(text)) return []
    this.sawControlMarker = true
    const lines = text.split(/\r?\n/).filter((line) => hasControlMarker(line))
    return lines.length ? [{ kind: 'text', text: lines.join('\n') }] : []
  }

  private streamError(event: Record<string, unknown>): AgentStreamEvent[] {
    const nested = isRecord(event.error) ? event.error : event
    const data = isRecord(nested.data) ? nested.data : undefined
    const message = stringField(nested, 'message') ?? (data ? stringField(data, 'message') : undefined)
    if (!message) return []
    // Transport chatter (e.g. "Reconnecting…") is not a user-facing failure;
    // real auth/quota/turn failures still land as raw transcript text.
    if (/\breconnecting\b/i.test(message)) return []
    // Codex warns about the hook-trust flag Farol passes for Ask first; that is Farol's own choice.
    if (isCodexHookTrustWarning(message)) return []
    return [{ kind: 'raw', text: `${message}\n` }]
  }
}
