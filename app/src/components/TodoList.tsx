import { useEffect, useId, useRef, useState } from 'react'
import { TODO_PRIORITIES, TODO_STATUSES, todoSummary, type Todo } from '@shared/todos'
import { C } from '../theme'
import { Button, ConfirmButton } from './controls'
import { ChevronDown } from './icons'

const STATUS_LABELS = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled'
}

const fieldStyle: React.CSSProperties = {
  background: C.terminal,
  color: C.text,
  border: `1px solid ${C.cardBorder}`,
  borderRadius: 6,
  padding: '6px 8px',
  font: 'inherit',
  minWidth: 0
}

function TodoEditor({
  todos,
  saving,
  onSave,
  onCancel
}: {
  todos: Todo[]
  saving: boolean
  onSave: (next: Todo[], expected: Todo[]) => Promise<void>
  onCancel: () => void
}) {
  const [original] = useState(todos)
  const [draft, setDraft] = useState(todos)
  const changed = JSON.stringify(todos) !== JSON.stringify(original)
  const update = (index: number, patch: Partial<Todo>): void => {
    setDraft((items) => items.map((item, i) => i === index ? { ...item, ...patch } : item))
  }
  return (
    <form onSubmit={(event) => {
      event.preventDefault()
      if (!saving && !changed) void onSave(draft, original)
    }}>
      {changed && (
        <p role="status" style={{ color: C.textMuted }}>
          The shared list changed. Cancel and edit the latest list before saving.
        </p>
      )}
      <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {draft.map((todo, index) => (
            <li key={index} style={{ padding: '10px 0', borderBottom: `1px solid ${C.cardBorder}` }}>
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
                <Button type="button" variant="danger" aria-label={`Remove todo ${index + 1}`} onClick={() => setDraft((items) => items.filter((_, i) => i !== index))}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ol>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingTop: 12 }}>
          <Button type="button" onClick={() => setDraft((items) => [...items, { content: '', status: 'pending', priority: 'medium' }])}>Add todo</Button>
          <span style={{ flex: 1 }} />
          <Button type="button" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving || changed || draft.some((todo) => !todo.content.trim())}>
            {saving ? 'Saving…' : 'Save list'}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}

export default function TodoList({ projectPath }: { projectPath: string }) {
  const [snapshot, setSnapshot] = useState<{ checkout: string; todos: Todo[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  const mounted = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()

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
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load the todo list')
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
        setEditing(false)
        trigger.current?.focus()
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'Could not save the todo list')
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const dismiss = (): void => {
    setOpen(false)
    trigger.current?.focus()
  }

  return (
    <section style={{ maxWidth: 680, margin: '0 auto 10px', color: C.textSoft, fontSize: 12.5 }}>
      <button
        ref={trigger}
        className="bf-focus bf-hover-fill"
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, width: '100%', minHeight: 30, padding: '6px 10px', border: `1px solid ${C.cardBorder}`, borderRadius: 8, background: 'transparent', color: C.textSoft, font: 'inherit', cursor: 'pointer' }}
      >
        <span aria-hidden="true" style={{ display: 'flex', transform: open ? 'rotate(180deg)' : undefined }}>
          <ChevronDown size={12} />
        </span>
        Todo list
        <span style={{ marginLeft: 'auto', color: C.textMuted, fontSize: 11.5 }}>
          {snapshot ? (snapshot.todos.length ? todoSummary(snapshot.todos) : 'No todos') : error ? 'Unavailable' : 'Loading…'}
        </span>
      </button>
        <div
          id={id}
          hidden={!open}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              dismiss()
            }
          }}
          style={{ maxHeight: 'min(360px, 40vh)', overflowY: 'auto', padding: '8px 2px' }}
        >
          <p style={{ margin: '0 0 8px', color: C.textMuted, lineHeight: 1.45 }}>Shared by every chat in this checkout.</p>
          {error && (
            <div role="alert" style={{ color: C.red, overflowWrap: 'anywhere', marginBottom: 8 }}>
              {error}
              {!snapshot && <Button type="button" onClick={() => setReload((value) => value + 1)} style={{ marginLeft: 8 }}>Retry</Button>}
            </div>
          )}
          {!snapshot && !error && <p role="status">Loading todos…</p>}
          {snapshot && (editing ? (
            <TodoEditor todos={snapshot.todos} saving={saving} onSave={save} onCancel={() => { setEditing(false); setError(null) }} />
          ) : (
            <>
              {!snapshot.todos.length && <p style={{ color: C.textMuted }}>No todos yet. Add one or ask the agent to plan the work.</p>}
              <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {snapshot.todos.map((todo, index) => (
                  <li key={index} style={{ padding: '10px 0', borderBottom: `1px solid ${C.cardBorder}` }}>
                    <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5 }}>{todo.content}</div>
                    <div style={{ color: C.textMuted, marginTop: 4, fontSize: 11.5 }}>{STATUS_LABELS[todo.status]} · {todo.priority} priority</div>
                  </li>
                ))}
              </ol>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                <Button type="button" disabled={saving} onClick={() => setEditing(true)}>Edit list</Button>
                {snapshot.todos.length > 0 && !saving && (
                  <ConfirmButton label="Clear list" confirmLabel="Confirm clear" title="Remove all todos from every chat in this checkout" onConfirm={() => void save([], snapshot.todos)} />
                )}
                {saving && <span role="status">Saving…</span>}
                <span style={{ flex: 1 }} />
                <Button type="button" variant="ghost" onClick={dismiss}>Dismiss</Button>
              </div>
            </>
          ))}
        </div>
    </section>
  )
}
