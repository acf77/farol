/**
 * The per-checkout todo list a managed agent maintains, carried as a single
 * `FAROL_TODOS:` JSON array that replaces the whole list.
 */

import { TODOS_MARKER, lastControlLine, lastControlMarkerLine } from './control-line'

export { TODOS_MARKER }

export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const
export const TODO_PRIORITIES = ['high', 'medium', 'low'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]
export type TodoPriority = (typeof TODO_PRIORITIES)[number]

export interface Todo {
  content: string
  status: TodoStatus
  priority: TodoPriority
}

export interface TodoStore {
  load(checkout: string): Promise<Todo[]>
  save(checkout: string, todos: unknown): Promise<void>
  forget(checkout: string): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
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
  return { content: text, status, priority }
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
  return { content, status, priority }
}

export function parseTodosMarker(output: string): Todo[] | null {
  const raw = lastControlLine(output, TODOS_MARKER)
  if (raw === undefined) return null
  if (lastControlMarkerLine(output)?.marker === TODOS_MARKER) return null
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return null
    const todos = value.map(strictTodo)
    return todos.some((todo) => todo === null) ? null : (todos as Todo[])
  } catch {
    return null
  }
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

export function formatTodos(todos: Todo[]): string {
  if (!todos.length) return 'No todos yet.'
  return todos.map((todo) => `- [${todo.status}] (${todo.priority}) ${todo.content}`).join('\n')
}
