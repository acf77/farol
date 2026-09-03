import { isQuestionToolName, questionsFromToolInput, type AgentQuestion } from './questions'

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
 * and tool items.
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

/** Protocol JSON must not land in the transcript — recover a card or drop it. */
function handleBrokenStreamJson(text: string): AgentStreamEvent[] {
  const recovered = recoverCodexItem(text)
  if (recovered.length) return recovered
  return []
}

export class AgentStreamParser {
  private buffer = ''
  /** tool_use id -> name, so a later tool_result can name the card it closes. */
  private names = new Map<string, string>()

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
    return isRecord(value) ? this.event(value) : [{ kind: 'raw', text: `${line}\n` }]
  }

  private event(event: Record<string, unknown>): AgentStreamEvent[] {
    switch (event.type) {
      case 'assistant':
        return this.content(event, 'assistant')
      case 'user':
        return this.content(event, 'user')
      case 'tool_call':
        return this.cursorTool(event)
      case 'item.started':
        return this.codexItem(event, false)
      case 'item.updated':
        // Mid-turn progress (todo ticks, partial tool detail) — keep the card live.
        return this.codexItem(event, false)
      case 'item.completed':
        return this.codexItem(event, true)
      case 'turn.failed':
      case 'error':
        // Top-level `error` is a documented Codex JSONL type (auth/quota/etc.);
        // without this, Chat stays blank aside from a non-zero exit.
        return this.codexError(event)
      // Session banners, rate-limit notices, reasoning, and the closing
      // `result` (a replay of text already emitted) are not chat content.
      case 'system':
      case 'result':
      case 'thinking':
      case 'rate_limit_event':
      case 'stream_event':
      case 'thread.started':
      case 'turn.started':
      case 'turn.completed':
        return []
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
    if (role === 'assistant' && item.type === 'text' && typeof item.text === 'string') {
      return item.text.trim() ? { kind: 'text', text: item.text } : undefined
    }
    if (role === 'assistant' && item.type === 'tool_use') {
      const toolId = normalizeId(item.id, `tool-${this.names.size}`)
      const name = typeof item.name === 'string' && item.name ? item.name : 'tool'
      this.names.set(toolId, name)
      const asked = isQuestionToolName(name) ? questionsFromToolInput(item.input) : undefined
      if (asked) return { kind: 'question', toolId, questions: asked }
      return { kind: 'tool', toolId, name, detail: toolDetail(item.input), state: 'running' }
    }
    if (role !== 'user' || item.type !== 'tool_result') return undefined
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
    if (type === 'error') return completed ? this.codexError(item) : []

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

  private codexError(event: Record<string, unknown>): AgentStreamEvent[] {
    const nested = isRecord(event.error) ? event.error : event
    const message = stringField(nested, 'message')
    if (!message) return []
    // Transport chatter (e.g. "Reconnecting…") is not a user-facing failure;
    // real auth/quota/turn failures still land as raw transcript text.
    if (/\breconnecting\b/i.test(message)) return []
    return [{ kind: 'raw', text: `${message}\n` }]
  }
}
