/**
 * What a managed Chat carries from one agent turn to the next.
 *
 * Every turn is a fresh CLI process. When the CLI kept its own conversation
 * (`session`) and the next turn runs on that same CLI and directory, Farol
 * resumes it and sends only the new request: the CLI already holds every
 * reply and tool result, and compacts its own context. Otherwise (another
 * provider after a fallback, a restart that lost the session, OMP) Farol
 * rebuilds the context from the chat's own record: the task, the user's
 * follow-ups, and the agent's handoff note.
 */

import type { AiCli } from './ai'
import { HANDOFF_MARKER, lastControlLine } from './control-line'

export { HANDOFF_MARKER }

/** A coding CLI's own saved conversation. Only valid for that CLI in that directory. */
export interface AgentSessionRef {
  cli: AiCli
  id: string
  cwd: string
}

export interface AgentContext {
  /** The message that started the chat. */
  task: string
  /** Later user messages and answers, oldest first. */
  followUps: string[]
  /** The agent's own summary for whichever agent takes the next turn. */
  handoff?: string
  session?: AgentSessionRef
}

/**
 * Budget for the rebuilt history (task plus follow-ups). The handoff note and
 * Farol's standing rules come on top. Bounded because it is sent on every
 * turn that cannot resume, and kept in memory for the life of the chat.
 */
export const MAX_HISTORY_CHARS = 100_000
/** The task always survives trimming, but a pasted log cannot fill the budget. */
export const MAX_TASK_CHARS = 20_000
export const MAX_HANDOFF_CHARS = 4_000
const MAX_FOLLOW_UPS = 200

/** CLIs whose headless mode can continue a saved conversation by id. */
const RESUMABLE: ReadonlySet<AiCli> = new Set<AiCli>(['claude', 'codex', 'cursor', 'opencode'])

export function canResume(cli: AiCli): boolean {
  return RESUMABLE.has(cli)
}

/** The session id to resume, or undefined when the next turn must rebuild its context. */
export function resumableSession(context: AgentContext, cli: AiCli, cwd: string): string | undefined {
  const session = context.session
  return session && canResume(cli) && session.cli === cli && session.cwd === cwd ? session.id : undefined
}

export function newAgentContext(task: string): AgentContext {
  return { task, followUps: [] }
}

export function addFollowUp(context: AgentContext, text: string): AgentContext {
  const followUps = [...context.followUps, text]
  return {
    ...context,
    followUps: followUps.length > MAX_FOLLOW_UPS ? followUps.slice(-MAX_FOLLOW_UPS) : followUps
  }
}

function head(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} characters omitted]` : text
}

function tail(text: string, max: number): string {
  return text.length > max ? `[… ${text.length - max} characters omitted]\n${text.slice(-max)}` : text
}

/**
 * The task and as many of the latest follow-ups as fit in `max`. Trimming
 * drops the oldest follow-ups first and says so — never the task, which is
 * what the rest of the chat refers back to.
 */
export function historyText(context: AgentContext, max = MAX_HISTORY_CHARS): string {
  const task = head(context.task, Math.min(MAX_TASK_CHARS, Math.floor(max / 2)))
  let budget = max - task.length
  const kept: string[] = []
  for (let i = context.followUps.length - 1; i >= 0; i--) {
    const line = `Follow-up: ${context.followUps[i]}`
    if (line.length + 2 <= budget) {
      kept.unshift(line)
      budget -= line.length + 2
      continue
    }
    // The latest message is the one the turn is about; keep its end.
    if (!kept.length && budget > 200) kept.unshift(tail(line, budget - 60))
    break
  }
  const dropped = context.followUps.length - kept.length
  const note = dropped
    ? [`[Farol left out ${dropped} earlier follow-up${dropped === 1 ? '' : 's'} to stay within the context budget.]`]
    : []
  return [task, ...note, ...kept].join('\n\n')
}

/** Parse the last `FAROL_HANDOFF:` line: a JSON string (for line breaks) or plain text. */
export function parseHandoffMarker(text: string): string | undefined {
  const raw = lastControlLine(text, HANDOFF_MARKER)
  if (raw === undefined) return undefined
  let note = raw
  if (raw.startsWith('"')) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed === 'string') note = parsed
    } catch {
      /* keep the raw text */
    }
  }
  note = note.trim()
  if (!note) return undefined
  return note.length > MAX_HANDOFF_CHARS ? note.slice(0, MAX_HANDOFF_CHARS) : note
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.trim() ? field.trim() : undefined
}

function sanitizeSessionRef(raw: unknown): AgentSessionRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const cli = value.cli
  const id = stringField(value, 'id')
  const cwd = stringField(value, 'cwd')
  if (typeof cli !== 'string' || !RESUMABLE.has(cli as AiCli) || !id || !cwd) return undefined
  return { cli: cli as AiCli, id, cwd }
}

/** Accept a context from the renderer (restored from disk); undefined when it has no task. */
export function sanitizeAgentContext(raw: unknown): AgentContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const task = stringField(value, 'task')
  if (!task) return undefined
  const followUps = Array.isArray(value.followUps)
    ? value.followUps.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : []
  const handoff = stringField(value, 'handoff')
  const session = sanitizeSessionRef(value.session)
  return {
    task,
    followUps: followUps.slice(-MAX_FOLLOW_UPS),
    ...(handoff ? { handoff: handoff.slice(0, MAX_HANDOFF_CHARS) } : {}),
    ...(session ? { session } : {})
  }
}

/** What a chat pane persists: small, since the workspace file is rewritten often. */
export interface SavedAgentContext {
  handoff?: string
  session?: AgentSessionRef
}

export function sanitizeSavedAgentContext(raw: unknown): SavedAgentContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const handoff = stringField(value, 'handoff')
  const session = sanitizeSessionRef(value.session)
  if (!handoff && !session) return undefined
  return {
    ...(handoff ? { handoff: handoff.slice(0, MAX_HANDOFF_CHARS) } : {}),
    ...(session ? { session } : {})
  }
}

/**
 * Rebuild a context after a restart: the task and follow-ups come from the
 * transcript's user messages, the rest from what the pane saved.
 */
export function restoredAgentContext(
  userMessages: string[],
  saved: SavedAgentContext | undefined
): AgentContext | undefined {
  const [task, ...followUps] = userMessages.filter((text) => text.trim())
  if (!task) return undefined
  return sanitizeAgentContext({ task, followUps, ...saved })
}
