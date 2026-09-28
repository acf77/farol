import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { shortPath } from '@shared/project-groups'
import type { GitInfo, WorktreeRequest } from '@shared/types'
import { branchNameError, worktreeFolderName } from '@shared/worktree'
import { C, MONO, glass as G } from '../theme'

interface Props {
  liquid?: boolean
  git: GitInfo
  /** Absolute project path — used to mark the current project in the list. */
  projectPath: string
  /** Repo folder name, used to preview the default worktree folder. */
  repoName: string
  busy: boolean
  /** Message from a failed attempt — the dialog stays open so it can be fixed. */
  error: string | null
  onCancel: () => void
  /** Open an existing worktree as its own project. */
  onOpenExisting: (branch: string) => void
  onCreate: (req: WorktreeRequest) => void
}

const label: React.CSSProperties = {
  width: 92,
  flex: 'none',
  fontSize: 11,
  color: C.textMuted
}

const field: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 26,
  padding: '0 8px',
  borderRadius: 6,
  border: '1px solid #3E3E3A',
  background: 'rgba(255,255,255,0.05)',
  color: C.text,
  fontSize: 12,
  fontFamily: MONO,
  outline: 'none',
  userSelect: 'text'
}

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 }

type ExistingInfo = { where: string; checkedOut: boolean }

function resolveExisting(
  name: string,
  git: GitInfo
): ExistingInfo | null {
  if (!name) return null
  const tree = (git.worktrees ?? []).find((w) => w.branch === name)
  if (tree) return { where: tree.path, checkedOut: true }
  if (!git.bare && name === git.branch) return { where: 'this project', checkedOut: true }
  if (git.branches.includes(name)) return { where: '', checkedOut: false }
  return null
}

function ExistingWorkspaces({
  workspaces,
  projectPath,
  existingPick,
  busy,
  onPick,
  onOpen
}: {
  workspaces: { path: string; branch: string }[]
  projectPath: string
  existingPick: string
  busy: boolean
  onPick: (value: string) => void
  onOpen: () => void
}) {
  const selectId = useId()
  const canOpen = !!existingPick && !busy
  return (
    <>
      <div style={row}>
        <label htmlFor={selectId} style={label}>Open existing</label>
        <select
          id={selectId}
          className="bf-input bf-focus"
          value={existingPick}
          disabled={busy}
          onChange={(e) => onPick(e.target.value)}
          style={{ ...field, fontSize: 11 }}
        >
          <option value="">Select workspace…</option>
          {workspaces.map((w) => {
            const main =
              w.path.replace(/[/\\]+$/, '') === projectPath.replace(/[/\\]+$/, '')
            return (
              <option key={w.path} value={w.branch}>
                {w.branch}
                {main ? ' (this project)' : ` — ${shortPath(w.path)}`}
              </option>
            )
          })}
        </select>
        <button
          type="button"
          className="bf-focus"
          disabled={!canOpen}
          onClick={onOpen}
          style={{
            flex: 'none',
            height: 26,
            padding: '0 12px',
            borderRadius: 6,
            border: 'none',
            background: canOpen ? C.accent : C.border,
            color: canOpen ? C.accentInk : C.faint,
            fontSize: 12,
            fontWeight: 600,
            cursor: canOpen ? 'pointer' : 'default'
          }}
        >
          Open
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          margin: '2px 0'
        }}
      >
        <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.09)' }} />
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.4px',
            textTransform: 'uppercase',
            color: C.fainter
          }}
        >
          or create
        </span>
        <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.09)' }} />
      </div>
    </>
  )
}

function BaseBranchSelect({
  base,
  existing,
  git,
  onChange
}: {
  base: string
  existing: ExistingInfo | null
  git: GitInfo
  onChange: (value: string) => void
}) {
  const selectId = useId()
  return (
    <div style={row}>
      <label htmlFor={selectId} style={label}>From branch</label>
      <select
        id={selectId}
        className="bf-input bf-focus"
        value={base}
        disabled={!!existing}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...field, fontSize: 11, opacity: existing ? 0.45 : 1 }}
      >
        <optgroup label="Local">
          {git.branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </optgroup>
        {!!git.remotes?.length && (
          <optgroup label="Remote">
            {git.remotes.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  )
}

function BranchHint({
  nameError,
  existing,
  folder,
  defaultFolder
}: {
  nameError: string | null
  existing: ExistingInfo | null
  folder: string
  defaultFolder: string
}) {
  if (nameError) {
    return <span style={{ color: '#FF817B' }}>{nameError}</span>
  }
  if (existing) {
    return (
      <span style={{ color: C.yellow }}>
        {existing.checkedOut
          ? `Already open at ${existing.where} — that project will be focused`
          : 'Branch exists — it will be checked out in a new worktree project'}
      </span>
    )
  }
  return (
    <span style={{ fontFamily: MONO, color: C.fainter }}>
      ../{folder.trim() || defaultFolder}
    </span>
  )
}

function DialogActions({
  busy,
  canSubmit,
  onCancel
}: {
  busy: boolean
  canSubmit: boolean
  onCancel: () => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        className="bf-focus"
        onClick={onCancel}
        style={{
          height: 26,
          padding: '0 12px',
          borderRadius: 6,
          border: '1px solid rgba(255,255,255,0.14)',
          background: 'transparent',
          color: C.textSoft,
          fontSize: 12,
          cursor: 'pointer'
        }}
      >
        Cancel
      </button>
      <button
        type="submit"
        className="bf-btn-primary bf-focus"
        disabled={!canSubmit}
        style={{
          height: 26,
          padding: '0 14px',
          borderRadius: 6,
          border: 'none',
          background: canSubmit ? C.accent : C.border,
          color: canSubmit ? C.accentInk : C.faint,
          fontSize: 12,
          fontWeight: 600,
          cursor: canSubmit ? 'pointer' : 'default'
        }}
      >
        {busy ? 'Opening…' : 'Open project'}
      </button>
    </div>
  )
}

export default function NewTabDialog({
  liquid,
  git,
  projectPath,
  repoName,
  busy,
  error,
  onCancel,
  onOpenExisting,
  onCreate
}: Props) {
  const [base, setBase] = useState(git.branch)
  const [branch, setBranch] = useState('')
  const [folder, setFolder] = useState('')
  const [existingPick, setExistingPick] = useState('')
  const titleId = useId()
  const descriptionId = useId()
  const branchId = useId()
  const folderId = useId()
  const nameHintId = useId()
  const errorId = useId()
  const branchRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  const workspaces = useMemo(() => {
    const trees = (git.worktrees ?? []).filter(
      (w): w is { path: string; branch: string } => !!w.branch
    )
    const main = projectPath.replace(/[/\\]+$/, '')
    trees.sort((a, b) => {
      const aMain = a.path.replace(/[/\\]+$/, '') === main ? 0 : 1
      const bMain = b.path.replace(/[/\\]+$/, '') === main ? 0 : 1
      if (aMain !== bMain) return aMain - bMain
      return a.branch.localeCompare(b.branch)
    })
    return trees
  }, [git.worktrees, projectPath])

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement
    dialog.showModal()
    branchRef.current?.focus({ preventScroll: true })
    return () => {
      const restore = dialog.contains(document.activeElement) || document.activeElement === document.body
      dialog.close()
      if (restore && previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true })
      }
    }
  }, [])

  const name = branch.trim()
  const nameError = name ? branchNameError(name) : null
  const defaultFolder = worktreeFolderName(repoName, name || 'branch')

  /** An existing branch is opened as it stands, so `base` would be a lie. */
  const existing = useMemo(() => resolveExisting(name, git), [name, git])

  const canSubmit = !!name && !nameError && !busy

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!canSubmit) return
    onCreate({
      branch: name,
      ...(existing ? {} : { base: base.trim() }),
      ...(folder.trim() ? { folder: folder.trim() } : {})
    })
  }

  const openExisting = (): void => {
    if (!existingPick || busy) return
    onOpenExisting(existingPick)
  }

  return (
    <dialog
      ref={dialogRef}
      className="bf-new-tab-dialog bf-page-overlay"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        maxWidth: 'none',
        maxHeight: 'none',
        margin: 0,
        padding: 16,
        border: 'none',
        boxSizing: 'border-box',
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(0,0,0,0.45)',
        color: C.text,
        font: 'inherit',
        overflow: 'auto'
      }}
    >
      <style>{`
        .bf-new-tab-dialog:not([open]) { display: none !important; }
        .bf-new-tab-dialog::backdrop { background: transparent; }
        .bf-new-tab-dialog > form > * { flex-shrink: 0; }
      `}</style>
      <form
        onSubmit={submit}
        aria-describedby={error ? errorId : undefined}
        style={{
          position: 'relative',
          width: 434,
          maxWidth: '100%',
          maxHeight: 'calc(100dvh - 32px)',
          boxSizing: 'border-box',
          overflow: 'auto',
          overflowWrap: 'anywhere',
          padding: 16,
          borderRadius: 8,
          background: liquid ? G.panel : C.panel,
          border: '1px solid #3E3E3A',
          boxShadow: '0 18px 48px rgba(0,0,0,0.55)',
          display: 'flex',
          flexDirection: 'column',
          gap: 11
        }}
      >
        <div id={titleId} style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Open branch as project</div>
        <div id={descriptionId} style={{ fontSize: 11, color: C.textMuted, lineHeight: 1.4, marginTop: -4 }}>
          Each branch gets its own worktree and project. Tabs inside a project share that checkout.
        </div>

        {workspaces.length > 0 && (
          <ExistingWorkspaces
            workspaces={workspaces}
            projectPath={projectPath}
            existingPick={existingPick}
            busy={busy}
            onPick={setExistingPick}
            onOpen={openExisting}
          />
        )}

        <BaseBranchSelect base={base} existing={existing} git={git} onChange={setBase} />

        <div style={row}>
          <label htmlFor={branchId} style={label}>New branch</label>
          <input
            id={branchId}
            ref={branchRef}
            className="bf-input bf-focus"
            aria-invalid={!!nameError}
            aria-describedby={`${nameHintId}${error ? ` ${errorId}` : ''}`}
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="ci/lint"
            spellCheck={false}
            style={field}
          />
        </div>

        <div style={row}>
          <label htmlFor={folderId} style={label}>Folder</label>
          <input
            id={folderId}
            className="bf-input bf-focus"
            aria-describedby={`${nameHintId}${error ? ` ${errorId}` : ''}`}
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder={defaultFolder}
            spellCheck={false}
            style={field}
          />
        </div>

        <div id={nameHintId} role="status" aria-atomic="true" style={{ minHeight: 15, paddingLeft: 102, fontSize: 11, lineHeight: '15px', overflowWrap: 'anywhere' }}>
          <BranchHint
            nameError={nameError}
            existing={existing}
            folder={folder}
            defaultFolder={defaultFolder}
          />
        </div>

        <div
          id={errorId}
          role="alert"
          aria-atomic="true"
          style={error ? {
            padding: '5px 8px',
            borderRadius: 6,
            background: 'rgba(255, 98, 90,0.15)',
            color: '#FF817B',
            fontSize: 11,
            overflowWrap: 'anywhere'
          } : { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}
        >
          {error}
        </div>

        <div style={{ height: 1, background: 'rgba(255,255,255,0.09)' }} />

        <DialogActions busy={busy} canSubmit={canSubmit} onCancel={onCancel} />
      </form>
    </dialog>
  )
}
