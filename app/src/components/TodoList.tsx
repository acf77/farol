import { useEffect, useId, useRef, useState } from 'react'
import { errorMessage } from '@shared/jev'
import {
  TODO_PRIORITIES,
  TODO_STATUSES,
  activeTodo,
  todoProgress,
  type Todo
} from '@shared/todos'
import { C } from '../theme'
import { Button, ConfirmButton } from './controls'
import { CancelIcon, CheckIcon, ChevronDown, CircleIcon, DeleteIcon, EditIcon, PlayIcon, Spinner } from './icons'

const STATUS_LABELS = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled'
}

const fieldStyle: React.CSSProperties = {
  background: C.terminal,
  color: C.text,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  padding: '6px 8px',
  font: 'inherit',
  minWidth: 0
}

function StatusGlyph({ status }: { status: Todo['status'] }) {
  if (status === 'pending') return <CircleIcon size={14} color={C.textMuted} />
  if (status === 'in_progress') return <Spinner size={14} color={C.accent} />
  if (status === 'completed') return <CheckIcon size={14} color={C.green} />
  return <CancelIcon size={14} color={C.textMuted} />
}

function TodoEditor({
  todos,
  index: editIndex,
  saving,
  onSave,
  onCancel
}: {
  todos: Todo[]
  index: number
  saving: boolean
  onSave: (next: Todo[], expected: Todo[]) => Promise<void>
  onCancel: () => void
}) {
  const [original] = useState(todos)
  const [draft, setDraft] = useState<Todo[]>(() => editIndex === todos.length
    ? [...todos, { content: '', status: 'pending', priority: 'medium' }]
    : todos)
  const listChangedSinceEdit = JSON.stringify(todos) !== JSON.stringify(original)
  const canSave = !saving && !listChangedSinceEdit && draft.every((todo) => todo.content.trim())
  const update = (index: number, patch: Partial<Todo>): void => {
    setDraft((items) => items.map((item, i) => i === index ? { ...item, ...patch } : item))
  }
  return (
    <form onSubmit={(event) => {
      event.preventDefault()
      if (canSave) void onSave(draft, original)
    }}>
      {listChangedSinceEdit && (
        <p role="status" style={{ color: C.textMuted }}>
          The shared list changed. Cancel and edit the latest list before saving.
        </p>
      )}
      <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {draft.map((todo, index) => index === editIndex && (
            <li key={index} style={{ padding: '10px 0', borderBottom: `1px solid ${C.border}` }}>
              <textarea
                className="bf-focus"
                aria-label={`Todo ${index + 1}`}
                required
                rows={2}
                value={todo.content}
                onChange={(event) => update(index, { content: event.target.value })}
                style={{ ...fieldStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                <select
                  className="bf-focus"
                  aria-label={`Status for todo ${index + 1}`}
                  value={todo.status}
                  onChange={(event) => update(index, { status: event.target.value as Todo['status'] })}
                  style={fieldStyle}
                >
                  {TODO_STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
                </select>
                <select
                  className="bf-focus"
                  aria-label={`Priority for todo ${index + 1}`}
                  value={todo.priority}
                  onChange={(event) => update(index, { priority: event.target.value as Todo['priority'] })}
                  style={fieldStyle}
                >
                  {TODO_PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority} priority</option>)}
                </select>
              </div>
            </li>
          ))}
        </ol>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingTop: 12 }}>
          <span style={{ flex: 1 }} />
          <Button type="button" variant="ghost" aria-label="Cancel editing" title="Cancel editing" onClick={onCancel} style={{ padding: '0 6px' }}><CancelIcon /></Button>
          <Button type="submit" variant="primary" disabled={!canSave}>
            {saving ? 'Saving…' : 'Save todo'}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}

function headerLabel(todos: Todo[] | null, error: string | null): string {
  if (todos) {
    if (!todos.length) return 'No todos'
    return todoProgress(todos).label
  }
  return error ? 'Unavailable' : 'Loading…'
}

/** Presentational OpenCode-style dock; data loading lives in `TodoList`. */
export function TodoDockView({
  todos,
  error,
  open,
  editing,
  saving,
  canRun,
  onToggle,
  onDismiss,
  onRetry,
  onRun,
  onEdit,
  onCancelEdit,
  onSave,
  triggerRef,
  bodyId
}: {
  todos: Todo[] | null
  error: string | null
  open: boolean
  editing: number | null
  saving: boolean
  canRun: boolean
  onToggle: () => void
  onDismiss: () => void
  onRetry: () => void
  onRun: (content: string) => void
  onEdit: (index: number) => void
  onCancelEdit: () => void
  onSave: (next: Todo[], expected: Todo[]) => Promise<void>
  triggerRef?: React.RefObject<HTMLButtonElement>
  bodyId?: string
}) {
  const generatedId = useId()
  const id = bodyId ?? generatedId
  const preview = todos ? activeTodo(todos)?.content : undefined
  const showList = open || editing !== null

  return (
    <section className="bf-todo-dock" style={{ width: '100%', color: C.textSoft, fontSize: 12 }}>
      <button
        ref={triggerRef}
        className="bf-focus bf-hover-fill bf-todo-dock-toggle"
        type="button"
        aria-expanded={showList}
        aria-controls={id}
        onClick={onToggle}
      >
        <span className="bf-todo-dock-progress">{headerLabel(todos, error)}</span>
        {preview && !showList && (
          <span className="bf-todo-dock-preview">{preview}</span>
        )}
        <span
          aria-hidden="true"
          className="bf-todo-dock-chevron"
          style={{ transform: showList ? 'rotate(180deg)' : undefined }}
        >
          <ChevronDown size={12} />
        </span>
      </button>
      <div
        id={id}
        className="bf-todo-dock-body"
        hidden={!showList}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (editing !== null) onCancelEdit()
          else onDismiss()
        }}
      >
        <p style={{ margin: '0 0 8px', color: C.textMuted, lineHeight: 1.45 }}>Shared by every chat in this checkout.</p>
        {error && (
          <div role="alert" style={{ color: C.red, overflowWrap: 'anywhere', marginBottom: 8 }}>
            {error}
            {todos === null && <Button type="button" onClick={onRetry} style={{ marginLeft: 8 }}>Retry</Button>}
          </div>
        )}
        {todos === null && !error && <p role="status">Loading todos…</p>}
        {todos && (editing !== null ? (
          <TodoEditor todos={todos} index={editing} saving={saving} onSave={onSave} onCancel={onCancelEdit} />
        ) : (
          <>
            {!todos.length && <p style={{ color: C.textMuted }}>No todos yet. Add one or ask the agent to plan the work.</p>}
            <ol className="bf-todo-dock-list" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {todos.map((todo, index) => {
                const done = todo.status === 'completed' || todo.status === 'cancelled'
                return (
                  <li key={index} className="bf-todo-row" data-status={todo.status}>
                    <span aria-hidden="true" className="bf-todo-status">
                      <StatusGlyph status={todo.status} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        className={done ? 'bf-todo-text is-done' : 'bf-todo-text'}
                        style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5 }}
                      >
                        {todo.content}
                      </div>
                      <span className="bf-sr-only">{STATUS_LABELS[todo.status]}</span>
                    </div>
                    <div className="bf-todo-actions">
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={saving || !canRun}
                        aria-label={`Run todo ${index + 1}`}
                        title="Send this todo to the agent"
                        onClick={() => onRun(todo.content)}
                        style={{ padding: '0 6px' }}
                      >
                        <PlayIcon />
                      </Button>
                      <Button type="button" variant="ghost" disabled={saving} aria-label={`Edit todo ${index + 1}`} title="Edit todo" onClick={() => onEdit(index)} style={{ padding: '0 6px' }}>
                        <EditIcon />
                      </Button>
                      {!saving && (
                        <ConfirmButton
                          label={<span role="img" aria-label={`Delete todo ${index + 1}`}><DeleteIcon /></span>}
                          confirmLabel="Delete todo?"
                          title="Delete todo from every chat in this checkout"
                          style={{ padding: '0 6px' }}
                          onConfirm={() => void onSave(todos.filter((_, i) => i !== index), todos)}
                        />
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={saving || done}
                        aria-label={`Cancel todo ${index + 1}`}
                        title="Mark todo as cancelled"
                        onClick={() => void onSave(todos.map((item, i) => i === index ? { ...item, status: 'cancelled' } : item), todos)}
                        style={{ padding: '0 6px' }}
                      >
                        <CancelIcon />
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ol>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              <Button type="button" disabled={saving} onClick={() => onEdit(todos.length)}>Add todo</Button>
              {saving && <span role="status">Saving…</span>}
              <span style={{ flex: 1 }} />
              <Button type="button" variant="ghost" onClick={onDismiss}>Dismiss</Button>
            </div>
          </>
        ))}
      </div>
    </section>
  )
}

export default function TodoList({
  projectPath,
  onRun,
  canRun
}: {
  projectPath: string
  /** Send a todo's content to the agent as a chat message. */
  onRun: (content: string) => void
  /** Whether the agent can take a new message right now (not busy, has an available model). */
  canRun: boolean
}) {
  const [snapshot, setSnapshot] = useState<{ checkout: string; todos: Todo[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  const mounted = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let cancelled = false
    let checkout: string | null = null
    const updates = new Map<string, Todo[]>()
    const unsubscribe = window.farol.todos.onChanged((next) => {
      if (checkout === null) updates.set(next.checkout, next.todos)
      else if (next.checkout === checkout) setSnapshot(next)
    })
    setError(null)
    void window.farol.todos.load(projectPath).then((next) => {
      if (cancelled) return
      checkout = next.checkout
      setSnapshot({ checkout, todos: updates.get(checkout) ?? next.todos })
      updates.clear()
    }).catch((reason: unknown) => {
      if (!cancelled) setError(errorMessage(reason, 'Could not load the todo list'))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [projectPath, reload])

  const save = async (next: Todo[], expected: Todo[]): Promise<void> => {
    if (!snapshot || saving) return
    setSaving(true)
    setError(null)
    try {
      await window.farol.todos.save(snapshot.checkout, next, expected)
      if (mounted.current) {
        setEditing(null)
        trigger.current?.focus()
      }
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason, 'Could not save the todo list'))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const dismiss = (): void => {
    setOpen(false)
    trigger.current?.focus()
  }

  return (
    <TodoDockView
      todos={snapshot?.todos ?? null}
      error={error}
      open={open}
      editing={editing}
      saving={saving}
      canRun={canRun}
      onToggle={() => setOpen(!open)}
      onDismiss={dismiss}
      onRetry={() => setReload((value) => value + 1)}
      onRun={onRun}
      onEdit={setEditing}
      onCancelEdit={() => { setEditing(null); setError(null) }}
      onSave={save}
      triggerRef={trigger}
    />
  )
}
