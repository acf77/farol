import { useEffect, useState } from 'react'
import {
  MAX_PROMPT_BODY,
  MAX_PROMPT_NAME,
  activePromptBlock,
  activePromptCount,
  type CustomPrompt,
  type CustomPromptSet
} from '@shared/custom-prompts'
import { errorMessage } from '@shared/jev'
import { C } from '../theme'
import { Button, Switch } from './controls'

/** Past this, the block is a noticeable cost on every turn. */
export const ACTIVE_CHARS_WARNING = 4000

type Scope = 'global' | 'project'

interface Draft {
  scope: Scope
  /** Absent for a new prompt. */
  id?: string
  name: string
  body: string
}

const field: React.CSSProperties = {
  padding: '0 10px',
  borderRadius: 7,
  border: `1px solid ${C.border}`,
  background: C.app,
  color: C.text,
  fontSize: 12
}

const EYEBROW: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: C.faint
}

const card: React.CSSProperties = {
  border: `1px solid ${C.hair}`,
  borderRadius: 12,
  background: C.sidebar,
  minWidth: 0
}

const ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }

function firstLine(body: string): string {
  return body.split('\n', 1)[0]
}

function PromptEditor({
  draft,
  busy,
  onChange,
  onSave,
  onCancel
}: {
  draft: Draft
  busy: boolean
  onChange: (next: Draft) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 16px' }}
      onSubmit={(e) => {
        e.preventDefault()
        onSave()
      }}
    >
      <input
        className="bf-input bf-focus"
        aria-label="Prompt name"
        placeholder="Name"
        maxLength={MAX_PROMPT_NAME}
        value={draft.name}
        onChange={(e) => onChange({ ...draft, name: e.target.value })}
        style={{ ...field, height: 30 }}
      />
      <textarea
        className="bf-input bf-focus"
        aria-label="Prompt text"
        placeholder="Instructions the agent should follow on every turn"
        maxLength={MAX_PROMPT_BODY}
        rows={6}
        value={draft.body}
        onChange={(e) => onChange({ ...draft, body: e.target.value })}
        style={{ ...field, padding: 10, resize: 'vertical', lineHeight: 1.45, fontFamily: 'inherit' }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button type="submit" variant="primary" disabled={busy || !draft.body.trim()}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: C.faint }}>
          {draft.body.length} / {MAX_PROMPT_BODY}
        </span>
      </div>
    </form>
  )
}

function PromptRow({
  prompt,
  active,
  busy,
  onToggle,
  onEdit,
  onDelete
}: {
  prompt: CustomPrompt
  active: boolean
  busy: boolean
  onToggle: (on: boolean) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <div style={ROW}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }} title={prompt.body}>
        <span style={{ fontSize: 13 }}>{prompt.name}</span>
        <span
          style={{ fontSize: 12, color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {firstLine(prompt.body)}
        </span>
      </div>
      {confirming ? (
        <>
          <Button variant="danger" disabled={busy} onClick={onDelete}>
            Delete
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </>
      ) : (
        <>
          <Button variant="ghost" disabled={busy} onClick={onEdit}>
            Edit
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirming(true)} aria-label={`Delete ${prompt.name}`}>
            Delete
          </Button>
        </>
      )}
      <Switch label={prompt.name} checked={active} onChange={(on) => !busy && onToggle(on)} />
    </div>
  )
}

/** Card whose rows are separated by hairlines. */
function Rows({ children }: { children: React.ReactNode[] }) {
  return (
    <div style={card}>
      {children.map((child, i) => (
        <div key={i} style={i ? { borderTop: `1px solid ${C.hair}` } : undefined}>
          {child}
        </div>
      ))}
    </div>
  )
}

/**
 * Standing instructions added to every chat turn while switched on. Global
 * prompts follow you across projects; project prompts live in the repo's
 * `.farol/prompts.json`, but whether they are on is decided on this machine.
 */
export function CustomPromptsSection({
  projectPath,
  projectName,
  onChange
}: {
  projectPath: string | null
  projectName?: string
  onChange?: (set: CustomPromptSet) => void
}) {
  const api = window.farol
  const [set, setSet] = useState<CustomPromptSet | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)

  useEffect(() => {
    let live = true
    setSet(null)
    setDraft(null)
    api.prompts
      .load(projectPath)
      .then((next) => {
        if (!live) return
        setSet(next)
        onChange?.(next)
      })
      .catch((err: unknown) => live && setError(errorMessage(err)))
    return () => {
      live = false
    }
  }, [api.prompts, onChange, projectPath])

  const run = (call: () => Promise<CustomPromptSet>): Promise<boolean> => {
    setBusy(true)
    return call()
      .then((next) => {
        setSet(next)
        onChange?.(next)
        setError(null)
        return true
      })
      .catch((err: unknown) => {
        setError(errorMessage(err))
        return false
      })
      .finally(() => setBusy(false))
  }

  if (!set) {
    return <div style={{ fontSize: 12, color: error ? C.red : C.textMuted }}>{error ?? 'Loading…'}</div>
  }

  const activeIds = new Set(set.activeProjectIds)
  const block = activePromptBlock(set.global, set.project, set.activeProjectIds)
  const activeCount = activePromptCount(set)

  const saveList = (scope: Scope, list: CustomPrompt[]): Promise<CustomPromptSet> =>
    scope === 'global' ? api.prompts.saveGlobal(projectPath, list) : api.prompts.saveProject(projectPath ?? '', list)

  const toggle = (scope: Scope, prompt: CustomPrompt, on: boolean): void => {
    if (scope === 'global') {
      void run(() => saveList('global', set.global.map((p) => (p.id === prompt.id ? { ...p, active: on } : p))))
      return
    }
    const ids = on ? [...set.activeProjectIds, prompt.id] : set.activeProjectIds.filter((id) => id !== prompt.id)
    void run(() => api.prompts.setProjectActive(projectPath ?? '', ids))
  }

  const remove = (scope: Scope, prompt: CustomPrompt): void => {
    const list = scope === 'global' ? set.global : set.project
    void run(() => saveList(scope, list.filter((p) => p.id !== prompt.id)))
  }

  const save = (current: Draft): void => {
    const list = current.scope === 'global' ? set.global : set.project
    const existing = list.find((p) => p.id === current.id)
    const prompt: CustomPrompt = {
      id: existing?.id ?? crypto.randomUUID(),
      name: current.name.trim() || 'Untitled prompt',
      body: current.body,
      // A new prompt starts on: you just wrote it for this machine.
      active: existing ? existing.active : true,
      updatedAt: Date.now()
    }
    const next = existing ? list.map((p) => (p.id === prompt.id ? prompt : p)) : [...list, prompt]
    void run(async () => {
      const saved = await saveList(current.scope, next)
      if (current.scope === 'project' && !existing) {
        return api.prompts.setProjectActive(projectPath ?? '', [...saved.activeProjectIds, prompt.id])
      }
      return saved
    }).then((ok) => ok && setDraft(null))
  }

  const group = (scope: Scope, title: string, list: CustomPrompt[], hint?: string) => {
    const disabled = scope === 'project' && !set.projectRoot
    const editingNew = draft?.scope === scope && !draft.id
    const rows: React.ReactNode[] = list.map((prompt) =>
      draft?.id === prompt.id ? (
        <PromptEditor
          key={prompt.id}
          draft={draft}
          busy={busy}
          onChange={setDraft}
          onSave={() => save(draft)}
          onCancel={() => setDraft(null)}
        />
      ) : (
        <PromptRow
          key={prompt.id}
          prompt={prompt}
          active={scope === 'global' ? prompt.active : activeIds.has(prompt.id)}
          busy={busy || !!draft}
          onToggle={(on) => toggle(scope, prompt, on)}
          onEdit={() => setDraft({ scope, id: prompt.id, name: prompt.name, body: prompt.body })}
          onDelete={() => remove(scope, prompt)}
        />
      )
    )
    if (editingNew) {
      rows.push(
        <PromptEditor
          key="new"
          draft={draft}
          busy={busy}
          onChange={setDraft}
          onSave={() => save(draft)}
          onCancel={() => setDraft(null)}
        />
      )
    }
    if (!rows.length) {
      rows.push(
        <div key="empty" style={{ ...ROW, fontSize: 12, color: C.faint }}>
          {disabled ? 'Open a project to add its prompts.' : 'No prompts yet.'}
        </div>
      )
    }
    return (
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 }}>
          <span style={EYEBROW}>{title}</span>
          {hint && <span style={{ fontSize: 11, color: C.fainter }}>{hint}</span>}
          <span style={{ flex: 1 }} />
          <Button
            variant="secondary"
            disabled={busy || disabled || !!draft}
            onClick={() => setDraft({ scope, name: '', body: '' })}
          >
            New prompt
          </Button>
        </div>
        <Rows>{rows}</Rows>
      </section>
    )
  }

  const over = block.length > ACTIVE_CHARS_WARNING
  return (
    <>
      <div style={{ fontSize: 12, lineHeight: 1.55, color: C.faint, textWrap: 'pretty' }}>
        Standing instructions added to every chat turn while switched on. Project prompts can be committed; whether
        they are on is saved only on this machine.
      </div>
      {group('global', 'Global', set.global, 'Every project')}
      {group(
        'project',
        'This project',
        set.project,
        set.projectRoot ? `${projectName ?? ''} · .farol/prompts.json`.replace(/^ · /, '') : undefined
      )}
      <div style={{ fontSize: 12, color: over ? C.yellow : C.faint }}>
        {activeCount
          ? `${activeCount} on · ${block.length.toLocaleString()} characters sent with every turn${
              over ? ' — consider trimming' : ''
            }`
          : 'None on. Switched-on prompts are sent with every chat turn.'}
      </div>
      {error && <div style={{ fontSize: 12, color: C.red }}>{error}</div>}
    </>
  )
}
