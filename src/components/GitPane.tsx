import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import { aiSelectionLabel } from '@shared/ai'
import {
  commitBlockReason,
  conflictSignals,
  conflictStatusItems,
  draftMatchesStatus,
  pushBlockReason
} from '@shared/git-status'
import type { AiProvider, GitCommit, GitFileKind, GitHubInfo, GitStatus } from '@shared/types'
import { useGitPanel } from '../hooks/useGitPanel'
import { C, MONO } from '../theme'
import { Button } from './controls'
import { SIDE_PANEL_WIDTH } from './side-panel'
import { CheckIcon, GitIcon, RetryIcon, Spinner } from './icons'

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
  return status && !status.clean ? C.yellow : C.green
}

const sectionLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.08em',
  color: C.textMuted,
  marginBottom: 6
}

const iconBtn: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 7,
  border: 0,
  background: 'transparent',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  color: C.textMuted
}

const KIND_LABEL: Record<GitFileKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflict: 'U'
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
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ ...sectionLabel, marginBottom: 4 }}>{title} ({files.length})</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {files.slice(0, 8).map((f) => (
          <div
            key={f.path}
            title={f.path}
            style={{
              fontFamily: MONO,
              fontSize: 10.5,
              color,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            <span style={{ opacity: 0.65, marginRight: 6 }}>{KIND_LABEL[f.kind]}</span>
            {f.path}
          </div>
        ))}
        {files.length > 8 && (
          <div style={{ fontSize: 10.5, color: C.faint }}>+{files.length - 8} more</div>
        )}
      </div>
    </div>
  )
}

function GitPanelHeader({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  return (
    <div
      style={{
        height: 44,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 7px 0 12px',
        borderBottom: `1px solid ${C.cardBorder}`
      }}
    >
      <GitIcon size={14} color={C.textMuted} />
      <span style={{ ...sectionLabel, letterSpacing: '0.09em', marginBottom: 0, flex: 1 }}>GIT</span>
      <button
        type="button"
        className="bf-focus bf-icon-btn"
        onClick={onRefresh}
        disabled={loading}
        title="Refresh git status"
        aria-label="Refresh git status"
        style={{ ...iconBtn, cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.5 : 1 }}
      >
        {loading ? <Spinner /> : <RetryIcon size={14} />}
      </button>
    </div>
  )
}

function RecentCommitsBlock({ commits }: { commits: GitCommit[] }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={sectionLabel}>RECENT COMMITS</div>
      {commits.length === 0 && (
        <div style={{ fontSize: 11.5, color: C.faint }}>No commits yet</div>
      )}
      {commits.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {commits.map((c) => (
            <div
              key={c.hash}
              title={`${c.subject}\n${c.author} · ${c.when}`}
              style={{
                padding: '6px 8px',
                borderRadius: 7,
                background: 'rgba(255,255,255,0.02)',
                border: `1px solid ${C.cardBorder}`
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
                <span style={{ fontFamily: MONO, fontSize: 10, color: C.accentBright }}>{c.hash}</span>
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
              <div style={{ fontSize: 10, color: C.faint }}>
                {c.author}
                {c.when ? ` · ${c.when}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
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
      <div style={sectionLabel}>CONFLICTS</div>
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
          style={{ fontSize: 11.5, color: i.tone === 'ok' ? C.green : C.faint, marginBottom: 4 }}
        >
          {i.text}
        </div>
      ))}
    </div>
  )
}

function ChangesBlock({ branch, status }: { branch: string; status: GitStatus | null }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={sectionLabel}>CHANGES · {branch}</div>
      {status && (status.ahead > 0 || status.behind > 0) && (
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
          {status.ahead > 0 && <span>{status.ahead} ahead</span>}
          {status.ahead > 0 && status.behind > 0 && <span> · </span>}
          {status.behind > 0 && <span>{status.behind} behind upstream</span>}
        </div>
      )}
      {status?.clean && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: C.green }}>
          <CheckIcon size={12} color={C.green} />
          Working tree clean
        </div>
      )}
      {status && !status.clean && (
        <>
          <FileList title="STAGED" files={status.staged} color={C.green} />
          <FileList title="UNSTAGED" files={status.unstaged} color={C.yellow} />
          <FileList title="UNTRACKED" files={status.untracked} color={C.accentBright} />
          <FileList title="CONFLICTS" files={status.conflicts} color={C.red} />
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

function GitActionButtons({
  provider,
  model,
  gitAction,
  draft,
  draftStale,
  ahead,
  canCommit,
  canPush,
  onPrepare,
  onDraftMessage,
  onCancelDraft,
  onConfirm,
  onPush
}: {
  provider: AiProvider
  model?: string
  gitAction: 'commit' | 'push' | null
  draft: ReturnType<typeof useGitPanel>['draft']
  draftStale: boolean
  ahead: number
  canCommit: boolean
  canPush: boolean
  onPrepare: () => void
  onDraftMessage: (message: string) => void
  onCancelDraft: () => void
  onConfirm: () => void
  onPush: () => void
}) {
  const [pushArmed, setPushArmed] = useState(false)
  const pushTitle =
    ahead > 0
      ? `Push ${ahead} unpushed commit${ahead === 1 ? '' : 's'} to the remote`
      : 'Nothing to push'
  const commitBusy = gitAction === 'commit'

  useEffect(() => {
    if (!canPush) {
      setPushArmed(false)
      return
    }
    if (!pushArmed) return
    const timer = window.setTimeout(() => setPushArmed(false), 6000)
    return () => window.clearTimeout(timer)
  }, [canPush, pushArmed])

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
          {draft.skipped.length > 0 && (
            <div style={{ fontSize: 10.5, color: C.yellow, lineHeight: 1.4 }}>
              Skipped {draft.skipped.join(', ')} — looks like a secret
            </div>
          )}
          {draftStale && (
            <div style={{ fontSize: 10.5, color: C.yellow, lineHeight: 1.4 }}>
              Working tree changed — generate the message again.
            </div>
          )}
          <textarea
            className="bf-input bf-focus"
            value={draft.message}
            onChange={(e) => onDraftMessage(e.target.value)}
            rows={3}
            spellCheck={false}
            aria-label="Commit message"
            style={{
              width: '100%',
              resize: 'vertical',
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
      <div style={{ display: 'flex', gap: 8 }}>
        {draft ? (
          <>
            <Button
              variant="primary"
              size="md"
              disabled={commitBusy || draftStale || !draft.message.trim()}
              onClick={() => void onConfirm()}
              title={`Commit ${draft.files.length} file${draft.files.length === 1 ? '' : 's'}`}
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
            <Button variant="ghost" size="md" disabled={commitBusy} onClick={onCancelDraft}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="md"
            disabled={!canCommit}
            onClick={() => void onPrepare()}
            title={`Generate a commit message with ${aiSelectionLabel(provider, model)}`}
            style={{ flex: 1 }}
          >
            {commitBusy ? (
              <>
                <Spinner /> Generating…
              </>
            ) : (
              'Commit with AI'
            )}
          </Button>
        )}
        {gitAction === 'push' ? (
          <Button variant="secondary" size="md" disabled style={{ flex: 1 }}>
            <Spinner /> Pushing…
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="md"
            disabled={!canPush}
            title={pushArmed ? (ahead === 1 ? 'Click again to push 1 commit' : `Click again to push ${ahead} commits`) : pushTitle}
            onClick={() => {
              if (!pushArmed) {
                setPushArmed(true)
                return
              }
              setPushArmed(false)
              void onPush()
            }}
            style={{ flex: 1 }}
          >
            {pushArmed ? (ahead === 1 ? 'Confirm push' : `Push ${ahead}?`) : 'Push'}
          </Button>
        )}
      </div>
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
        left: rect.left,
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
  refresh,
  prepareCommit,
  setDraftMessage,
  cancelDraft,
  confirmCommit,
  push,
  open,
  onClose,
  anchorRef
}: Props) {
  const pos = usePopoverPosition(anchorRef, open)
  useEscapeClose(open, onClose)

  if (!open || !pos) return null

  const canCommit = !!status && !commitBlockReason(status) && !gitAction
  const canPush = !!status && !pushBlockReason(status) && !gitAction
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
          width: SIDE_PANEL_WIDTH,
          maxHeight: 'min(70vh, 520px)',
          display: 'flex',
          flexDirection: 'column',
          background: '#232322',
          border: `1px solid ${C.cardBorder}`,
          borderRadius: 10,
          boxShadow: '0 18px 44px rgba(0,0,0,0.55)',
          overflow: 'hidden'
        }}
      >
        <GitPanelHeader loading={loading} onRefresh={() => void refresh()} />

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 10px 12px' }}>
          <ConflictBlock status={status} github={github} />
          <RecentCommitsBlock commits={commits} />
          <ChangesBlock branch={branch} status={status} />
          {error && <div style={alertBox('error')}>{error}</div>}
          {lastMessage && <div style={alertBox('success')}>{lastMessage}</div>}
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
          onPrepare={prepareCommit}
          onDraftMessage={setDraftMessage}
          onCancelDraft={cancelDraft}
          onConfirm={confirmCommit}
          onPush={push}
        />
      </div>
    </>
  )
}
