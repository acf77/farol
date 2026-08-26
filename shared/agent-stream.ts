/**
 * Turning a coding CLI's realtime NDJSON stream into chat events.
 *
 * With their default `text` output the managed CLIs print nothing until the
 * whole run is over — the chat sits silent while the agent edits files and
 * shells out. Their `stream-json` modes emit one JSON object per line as work
 * happens, which is what this parser reads.
 *
 * Claude and Cursor share the Anthropic-style `assistant`/`user` envelope;
 * Cursor adds its own `tool_call` events. Anything this does not recognize —
 * a warning line, a banner, a future event type — falls through as raw text
 * rather than being dropped, so a schema change degrades to today's behaviour
 * instead of a blank pane.
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

/** A line that was not JSON we understand; shown verbatim. */
export interface AgentStreamRaw {
  kind: 'raw'
  text: string
}

export type AgentStreamEvent = AgentStreamText | AgentStreamTool | AgentStreamRaw

/** A CLI that never emits a newline must not grow the buffer without bound. */
const MAX_LINE = 1_000_000
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
      return [{ kind: 'raw', text }]
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
      // Session banners, rate-limit notices, reasoning, and the closing
      // `result` (a replay of text already emitted) are not chat content.
      case 'system':
      case 'result':
      case 'thinking':
      case 'rate_limit_event':
      case 'stream_event':
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
      if (role === 'assistant' && item.type === 'text' && typeof item.text === 'string') {
        if (item.text.trim()) out.push({ kind: 'text', text: item.text })
      } else if (role === 'assistant' && item.type === 'tool_use') {
        const toolId = normalizeId(item.id, `tool-${this.names.size}`)
        const name = typeof item.name === 'string' && item.name ? item.name : 'tool'
        this.names.set(toolId, name)
        out.push({ kind: 'tool', toolId, name, detail: toolDetail(item.input), state: 'running' })
      } else if (role === 'user' && item.type === 'tool_result') {
        const toolId = normalizeId(item.tool_use_id, '')
        if (!toolId) continue
        out.push({
          kind: 'tool',
          toolId,
          name: this.names.get(toolId) ?? 'tool',
          state: item.is_error === true ? 'error' : 'done'
        })
      }
    }
    return out
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
    const detail = toolDetail(body.args)
    const subtype = event.subtype
    const state: AgentStreamTool['state'] =
      subtype === 'completed' ? 'done' : subtype === 'error' || subtype === 'failed' ? 'error' : 'running'
    return [{ kind: 'tool', toolId, name, ...(detail ? { detail } : {}), state }]
  }
}
