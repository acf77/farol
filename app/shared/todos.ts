/**
 * The per-checkout todo list a managed agent maintains, carried as a single
 * `FAROL_TODOS:` JSON array that replaces the whole list.
 */

import { ago } from './ago'
import { TODOS_MARKER } from './control-line'

export { TODOS_MARKER }

export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const
export const TODO_PRIORITIES = ['high', 'medium', 'low'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]
export type TodoPriority = (typeof TODO_PRIORITIES)[number]

/** The chat that added a todo. */
export interface TodoSource {
  chatId: string
  title: string
}

export interface Todo {
  content: string
  status: TodoStatus
  priority: TodoPriority
  /** Set by Farol, never by the agent. Absent for items the developer added and for lists saved before this field. */
  source?: TodoSource
  /** Epoch ms of the last status or priority change; set by Farol. */
  changedAt?: number
}

export interface TodoStore {
  load(checkout: string): Promise<Todo[]>
  save(checkout: string, todos: unknown, expected?: Todo[]): Promise<void>
  forget(checkout: string): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The optional fields Farol keeps on a todo; a malformed one is dropped, not the todo. */
function stamps(record: Record<string, unknown>): Pick<Todo, 'source' | 'changedAt'> {
  const { source, changedAt } = record
  return {
    ...(isRecord(source) && typeof source.chatId === 'string' && typeof source.title === 'string'
      ? { source: { chatId: source.chatId, title: source.title } }
      : {}),
    ...(typeof changedAt === 'number' && Number.isFinite(changedAt) ? { changedAt } : {})
  }
}

function todoFrom(value: unknown): Todo | null {
  const content =
    typeof value === 'string'
      ? value
      : isRecord(value) && typeof value.content === 'string'
        ? value.content
        : ''
  const text = content.trim()
  if (!text) return null
  const record = isRecord(value) ? value : {}
  const status = TODO_STATUSES.find((s) => s === String(record.status)) ?? 'pending'
  const priority = TODO_PRIORITIES.find((p) => p === String(record.priority)) ?? 'medium'
  return { content: text, status, priority, ...stamps(record) }
}

export function sanitizeTodos(raw: unknown): Todo[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(todoFrom)
    .filter((todo): todo is Todo => todo !== null)
}

function strictTodo(value: unknown): Todo | null {
  if (!isRecord(value) || typeof value.content !== 'string') return null
  const content = value.content.trim()
  const status = TODO_STATUSES.find((s) => s === value.status)
  const priority = TODO_PRIORITIES.find((p) => p === value.priority)
  if (!content || !status || !priority) return null
  return { content, status, priority, ...stamps(value) }
}

export function parseTodos(value: unknown): Todo[] | null {
  if (!Array.isArray(value)) return null
  const todos: Todo[] = []
  for (const entry of value) {
    const todo = strictTodo(entry)
    if (!todo) return null
    todos.push(todo)
  }
  return todos
}

/** The list in the JSON after a `FAROL_TODOS:` marker, or null if it is not a complete, valid list. */
export function parseTodosValue(raw: string): Todo[] | null {
  try {
    return parseTodos(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

/**
 * The agent's list with the fields Farol keeps. An item whose text matches one
 * already there keeps its source, and its change time while status and priority
 * hold; any other item is new to `chat` and stamped `now`. Whatever the agent
 * wrote in those fields is ignored.
 */
export function mergeTodos(
  previous: Todo[],
  next: Todo[],
  chat: TodoSource | undefined,
  now: number
): Todo[] {
  const known = new Map(previous.map((todo) => [todo.content, todo]))
  return next.map(({ content, status, priority }) => {
    const old = known.get(content)
    const source = old ? old.source : chat
    const changedAt = old && old.status === status && old.priority === priority ? old.changedAt : now
    return {
      content,
      status,
      priority,
      ...(source ? { source } : {}),
      ...(changedAt === undefined ? {} : { changedAt })
    }
  })
}

export function todoSummary(todos: Todo[]): string {
  if (!todos.length) return 'Todo list cleared'
  const open = todos.filter((todo) => todo.status === 'pending' || todo.status === 'in_progress').length
  const done = todos.filter((todo) => todo.status === 'completed').length
  const cancelled = todos.length - open - done
  return [`${open} open`, `${done} done`, ...(cancelled ? [`${cancelled} cancelled`] : [])].join(
    ' · '
  )
}

/** OpenCode-style collapsed header: completed count over total length. */
export function todoProgress(todos: Todo[]): { done: number; total: number; label: string } {
  const done = todos.filter((todo) => todo.status === 'completed').length
  const total = todos.length
  return { done, total, label: `${done} of ${total} todos completed` }
}

/**
 * Preview pick for the collapsed dock: in-progress, else pending, else last
 * completed, else the first item.
 */
export function activeTodo(todos: Todo[]): Todo | undefined {
  return (
    todos.find((todo) => todo.status === 'in_progress') ??
    todos.find((todo) => todo.status === 'pending') ??
    [...todos].reverse().find((todo) => todo.status === 'completed') ??
    todos[0]
  )
}

/** Who reads the list: which chat is "this chat", when it is, and when its current request began. */
export interface TodoViewer {
  chatId: string
  now: number
  since: number
}

/** Where an item came from and how old it is; a finished item from before `since` says so. */
function todoNote(todo: Todo, viewer: TodoViewer): string {
  const parts: string[] = []
  if (todo.source) {
    parts.push(todo.source.chatId === viewer.chatId ? 'this chat' : `chat "${todo.source.title}"`)
  }
  if (todo.changedAt !== undefined) parts.push(ago(todo.changedAt, viewer.now))
  const finished = todo.status === 'completed' || todo.status === 'cancelled'
  if (finished && (todo.changedAt ?? 0) < viewer.since) parts.push('earlier request')
  return parts.length ? ` ⟨${parts.join(' · ')}⟩` : ''
}

export function formatTodos(todos: Todo[], viewer: TodoViewer): string {
  if (!todos.length) return 'No todos yet.'
  return todos
    .map((todo) => `- [${todo.status}] (${todo.priority}) ${todo.content}${todoNote(todo, viewer)}`)
    .join('\n')
}

/** The CLI's own todo tools: bookkeeping for the agent, not work on the project. */
export function isAgentTodoToolName(name: string): boolean {
  return ['todowrite', 'todoread', 'updateplan'].includes(name.toLowerCase().replace(/[_-]/g, ''))
}
