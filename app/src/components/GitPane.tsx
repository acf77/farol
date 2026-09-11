import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import { aiSelectionLabel } from '@shared/ai'
import {
  commitBlockReason,
  conflictSignals,
  conflictStatusItems,
  draftMatchesStatus,
  pullRequestBlockReason,
  pushBlockReason
} from '@shared/git-status'
import type { AiProvider, GitCommit, GitFileKind, GitHubInfo, GitStatus } from '@shared/types'
import { useGitPanel, type GitAction } from '../hooks/useGitPanel'
import { C, MONO, UI } from '../theme'
import { Button } from './controls'
import { CheckIcon, GitIcon, Spinner } from './icons'

const POPOVER_WIDTH = 360
const MAX_FILES = 8

interface Props extends ReturnType<typeof useGitPanel> {
  branch: string
  provider: AiProvider
  model?: string
  open: boolean
  onClose: () => void
  anchorRef: RefObject<HTMLElement | null>
}

export function gitStatusDotColor(
  status: GitStatus | null,
  github: GitHubInfo | null
): string {
  if (conflictSignals(status, github).any) return C.red
  if (!status) return C.textMuted
  return status.clean ? C.green : C.yellow
}

const sectionLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: C.textMuted,
  marginBottom: 6
}

const KIND_LABEL: Record<GitFileKind, string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  untracked: 'New',
  conflict: 'Conflict'
}

function alertBox(variant: 'error' | 'success' | 'conflict'): CSSProperties {
  if (variant === 'conflict') {
    return {
      marginBottom: 10,
      padding: '8px 10px',
      borderRadius: 7,
      background: 'rgba(255, 98, 90,0.1)',
      border: '1px solid rgba(255, 98, 90,0.35)',
      fontSize: 11.5,
      color: C.red
    }
  }
  const green = variant === 'success'
  return {
    marginBottom: 10,
    padding: '8px 10px',
    borderRadius: 7,
    background: green ? 'rgba(135, 201, 174,0.08)' : 'rgba(255, 98, 90,0.08)',
    border: green ? '1px solid rgba(135, 201, 174,0.25)' : '1px solid rgba(255, 98, 90,0.25)',
    fontSize: 11.5,
    color: green ? C.textSoft : C.red,
    lineHeight: 1.45,
    ...(green ? { fontFamily: MONO } : {})
  }
}

function FileList({ title, files, color }: { title: string; files: GitStatus['staged']; color: string }) {
  if (!files.length) return null
  const visible = files.slice(0, MAX_FILES)
  const extra = files.length - visible.length
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ ...sectionLabel, marginBottom: 4 }}>{title} ({files.length})</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {visible.map((f) => (
          <div
            key={f.path}
            title={f.path}
            style={{
              fontFamily: MONO,
              fontSize: 11,
              display: 'flex',
              gap: 8,
              color: C.textSoft,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.path}</span>
            <span style={{ color, fontFamily: UI, flexShrink: 0 }}>{KIND_LABEL[f.kind]}</span>
          </div>
        ))}
        {extra > 0 && (
          <div style={{ fontSize: 11, color: C.textMuted }}>+{extra} more</div>
        )}
      </div>
    </div>
  )
}

function GitPanelHeader({ branch, loading, stale, onClose, onRetry }: {
  branch: string
  loading: boolean
  stale: boolean
  onClose: () => void
  onRetry: () => void
}) {
  return (
    <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: `1px solid ${C.cardBorder}` }}>
      <GitIcon size={15} color={C.textMuted} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div title={branch} style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{branch}</div>
        {(stale || loading) && (
          <div style={{ fontSize: 11, color: stale ? C.yellow : C.textMuted, marginTop: 3 }}>
            {stale ? 'Update failed.' : 'Updating…'}
          </div>
        )}
      </div>
      {stale && (
        <Button variant="ghost" size="sm" disabled={loading} onClick={onRetry}>Retry</Button>
      )}
      <Button variant="ghost" size="sm" autoFocus onClick={onClose} aria-label="Close Git popover">Close</Button>
    </div>
  )
}

function RecentCommitsBlock({ commits }: { commits: GitCommit[] }) {
  return (
    <details style={{ paddingTop: 12, borderTop: `1px solid ${C.cardBorder}` }}>
      <summary className="bf-focus" style={{ ...sectionLabel, cursor: 'pointer' }}>Recent commits</summary>
      {commits.length === 0 && (
        <div style={{ fontSize: 11.5, color: C.textMuted }}>No commits yet</div>
      )}
      {commits.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {commits.map((c) => (
            <div
              key={c.hash}
              title={`${c.subject}\n${c.author} · ${c.when}`}
              style={{
                padding: '4px 0'
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 6,
                  marginBottom: 2
                }}
              >
                <span style={{ fontFamily: MONO, fontSize: 11, color: C.accentBright }}>{c.hash}</span>
                <span
                  style={{
                    fontSize: 11,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1
                  }}
                >
                  {c.subject}
                </span>
              </div>
              <div style={{ fontSize: 11, color: C.textMuted }}>
                {c.author}
                {c.when ? ` · ${c.when}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </details>
  )
}

function ConflictBlock({
  status,
  github
}: {
  status: GitStatus | null
  github: GitHubInfo | null
}) {
  const items = conflictStatusItems(status, github)
  if (!items.length) return null
  const bad = items.filter((i) => i.tone === 'conflict')
  const rest = items.filter((i) => i.tone !== 'conflict')
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={sectionLabel}>Merge status</div>
      {bad.length > 0 && (
        <div style={alertBox('conflict')}>
          {bad.map((i) => (
            <div key={i.text}>{i.text}</div>
          ))}
        </div>
      )}
      {rest.map((i) => (
        <div
          key={i.text}
          style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 4 }}
        >
          {i.text}
        </div>
      ))}
    </div>
  )
}

function ChangesBlock({ status }: { status: GitStatus }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={sectionLabel}>Working changes</div>
      {(status.ahead > 0 || status.behind > 0) && (
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
          {status.ahead > 0 && <span>{status.ahead} to push</span>}
          {status.ahead > 0 && status.behind > 0 && <span> · </span>}
          {status.behind > 0 && <span>{status.behind} to pull</span>}
        </div>
      )}
      {status.clean && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: C.green }}>
          <CheckIcon size={12} color={C.green} />
          No uncommitted changes
        </div>
      )}
      {!status.clean && (
        <>
          <FileList title="Staged" files={status.staged} color={C.green} />
          <FileList title="Not staged" files={status.unstaged} color={C.yellow} />
          <FileList title="New files" files={status.untracked} color={C.accentBright} />
          <FileList title="Conflicts" files={status.conflicts} color={C.red} />
        </>
      )}
    </div>
  )
}

function useEscapeClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
}

/** A button whose action reaches the remote, so it asks for a second click first. */
function ConfirmButton({ label, confirmLabel, busyLabel, busy, disabled, title, onConfirm }: {
  label: string
  confirmLabel: string
  busyLabel: string
  busy: boolean
  disabled: boolean
  title: string
  onConfirm: () => void
}) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (disabled) {
      setArmed(false)
      return
    }
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 6000)
    return () => window.clearTimeout(timer)
  }, [armed, disabled])

  return (
    <Button
      variant="secondary"
      size="md"
      disabled={disabled}
      onBlur={() => setArmed(false)}
      title={armed ? 'Click again to confirm' : title}
      onClick={() => {
        if (!armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        onConfirm()
      }}
      style={{ flex: 1 }}
    >
      {busy ? <><Spinner /> {busyLabel}</> : armed ? confirmLabel : label}
    </Button>
  )
}

function GitActionButtons({
  provider,
  model,
  gitAction,
  draft,
  draftStale,
  ahead,
  canCommit,
  canPush,
  showCreatePr,
  canCreatePr,
  commitReason,
  pushReason,
  prReason,
  onPrepare,
  onDraftMessage,
  onCancelDraft,
  onConfirm,
  onPush,
  onCreatePr
}: {
  provider: AiProvider
  model?: string
  gitAction: GitAction | null
  draft: ReturnType<typeof useGitPanel>['draft']
  draftStale: boolean
  ahead: number
  canCommit: boolean
  canPush: boolean
  showCreatePr: boolean
  canCreatePr: boolean
  commitReason: string | null
  pushReason: string | null
  prReason: string | null
  onPrepare: () => void
  onDraftMessage: (message: string) => void
  onCancelDraft: () => void
  onConfirm: () => void
  onPush: () => void
  onCreatePr: () => void
}) {
  const commitBusy = gitAction === 'commit'

  return (
    <div
      style={{
        flex: 'none',
        padding: '10px 12px 12px',
        borderTop: `1px solid ${C.cardBorder}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 8
      }}
    >
      {draft && (
        <>
          <div style={sectionLabel}>Commit message</div>
          {draft.skipped.length > 0 && (
            <div style={{ fontSize: 11, color: C.yellow, lineHeight: 1.4, overflowWrap: 'anywhere' }}>
              Excluded possible secrets: {draft.skipped.join(', ')}
            </div>
          )}
          {draftStale && (
            <div style={{ fontSize: 11, color: C.yellow, lineHeight: 1.4 }}>
              The file list changed. Generate a new message before committing.
            </div>
          )}
          <textarea
            className="bf-input bf-focus"
            value={draft.message}
            onChange={(e) => onDraftMessage(e.target.value)}
            rows={3}
            disabled={!!gitAction}
            spellCheck={false}
            aria-label="Commit message"
            style={{
              width: '100%',
              resize: 'vertical',
              maxHeight: 140,
              padding: '6px 8px',
              borderRadius: 7,
              border: `1px solid ${C.cardBorder}`,
              background: 'rgba(255,255,255,0.03)',
              color: C.textSoft,
              fontFamily: MONO,
              fontSize: 11,
              lineHeight: 1.45,
              boxSizing: 'border-box'
            }}
          />
        </>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {draft ? (
          <>
            <Button
              variant="primary"
              size="md"
              disabled={!canCommit || draftStale || !draft.message.trim()}
              onClick={() => void onConfirm()}
              title={commitReason ?? `Commit ${draft.files.length} file${draft.files.length === 1 ? '' : 's'}`}
              style={{ flex: 1 }}
            >
              {commitBusy ? (
                <>
                  <Spinner /> Committing…
                </>
              ) : (
                `Commit ${draft.files.length} file${draft.files.length === 1 ? '' : 's'}`
              )}
            </Button>
            {draftStale && (
              <Button variant="secondary" size="md" disabled={!canCommit} onClick={onPrepare}>Regenerate</Button>
            )}
            <Button variant="ghost" size="md" disabled={!!gitAction} onClick={onCancelDraft}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="md"
            disabled={!canCommit}
            onClick={() => void onPrepare()}
            title={commitReason ?? `Generate a commit message with ${aiSelectionLabel(provider, model)}`}
            style={{ flex: 1 }}
          >
            {commitBusy ? (
              <>
                <Spinner /> Generating…
              </>
            ) : (
              'Draft commit message'
            )}
          </Button>
        )}
        <ConfirmButton
          label={`Push${ahead > 0 ? ` (${ahead})` : ''}`}
          confirmLabel="Confirm push"
          busyLabel="Pushing…"
          busy={gitAction === 'push'}
          disabled={!canPush}
          title={pushReason ?? `Push ${ahead} unpushed commit${ahead === 1 ? '' : 's'} to the remote`}
          onConfirm={onPush}
        />
      </div>
      {showCreatePr && (
        <div style={{ display: 'flex' }}>
          <ConfirmButton
            label="Create pull request"
            confirmLabel="Confirm pull request"
            busyLabel="Creating pull request…"
            busy={gitAction === 'pr'}
            disabled={!canCreatePr}
            title={prReason ?? 'Open a pull request for this branch on GitHub'}
            onConfirm={onCreatePr}
          />
        </div>
      )}
      <div style={{ fontSize: 11, color: C.textMuted, lineHeight: 1.45 }}>
        {draft ? 'Review the message, then commit locally.' : commitReason ?? 'Includes staged, unstaged, and new files. Review before committing.'}
      </div>
      {pushReason && ahead > 0 && <div style={{ fontSize: 11, color: C.yellow }}>{pushReason}</div>}
      {showCreatePr && prReason && <div style={{ fontSize: 11, color: C.textMuted }}>{prReason}</div>}
    </div>
  )
}

function usePopoverPosition(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean
): { left: number; bottom: number } | null {
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const anchor = anchorRef.current
    if (!anchor) return
    const update = (): void => {
      const rect = anchor.getBoundingClientRect()
      setPos({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 16)),
        bottom: window.innerHeight - rect.top + 8
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchorRef, open])

  return pos
}

export default function GitPane({
  branch,
  provider,
  model,
  status,
  commits,
  github,
  loading,
  gitAction,
  draft,
  lastMessage,
  error,
  refreshError,
  refresh,
  prepareCommit,
  setDraftMessage,
  cancelDraft,
  confirmCommit,
  push,
  createPr,
  open,
  onClose,
  anchorRef
}: Props) {
  const pos = usePopoverPosition(anchorRef, open)
  useEscapeClose(open, onClose)

  useEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    return () => anchor?.focus()
  }, [open, anchorRef])

  if (!open || !pos) return null

  const commitReason = status ? commitBlockReason(status) : 'Reading working changes…'
  const pushReason = status ? pushBlockReason(status) : 'Reading remote status…'
  const prReason = pullRequestBlockReason(status)
  const canCommit = !commitReason && !gitAction
  const canPush = !pushReason && !gitAction
  const canCreatePr = !prReason && !gitAction
  const draftStale = !!draft && !!status && !draftMatchesStatus(draft.files, status)

  return (
    <>
      <div aria-hidden onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 55 }} />
      <div
        role="dialog"
        aria-label="Git"
        style={{
          position: 'fixed',
          left: pos.left,
          bottom: pos.bottom,
          zIndex: 60,
          width: POPOVER_WIDTH,
          maxWidth: 'calc(100vw - 16px)',
          maxHeight: 'min(70vh, 520px)',
          display: 'flex',
          flexDirection: 'column',
          background: C.panel,
          color: C.textSoft,
          border: `1px solid ${C.cardBorder}`,
          borderRadius: 10,
          boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
          overflow: 'hidden'
        }}
      >
        <GitPanelHeader
          branch={branch}
          loading={loading}
          stale={!!refreshError}
          onClose={onClose}
          onRetry={refresh}
        />

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px' }}>
          {refreshError && <div role="alert" style={alertBox('error')}>{refreshError}</div>}
          {error && <div role="alert" style={alertBox('error')}>{error}</div>}
          {lastMessage && <div role="status" style={alertBox('success')}>{lastMessage}</div>}
          {status ? <ChangesBlock status={status} /> : <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>Reading working changes…</div>}
          <ConflictBlock status={status} github={github} />
          {github && !github.available && <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12 }}>{github.message}</div>}
          {status && <RecentCommitsBlock commits={commits} />}
        </div>

        <GitActionButtons
          provider={provider}
          model={model}
          gitAction={gitAction}
          draft={draft}
          draftStale={draftStale}
          ahead={status?.ahead ?? 0}
          canCommit={canCommit}
          canPush={canPush}
          showCreatePr={!!github?.available && github.prs.length === 0}
          canCreatePr={canCreatePr}
          commitReason={commitReason}
          pushReason={pushReason}
          prReason={prReason}
          onPrepare={prepareCommit}
          onDraftMessage={setDraftMessage}
          onCancelDraft={cancelDraft}
          onConfirm={confirmCommit}
          onPush={push}
          onCreatePr={createPr}
        />
      </div>
    </>
  )
}
