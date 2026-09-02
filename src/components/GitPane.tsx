import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import { aiSelectionLabel } from '@shared/ai'
import { commitBlockReason, draftMatchesStatus, pushBlockReason } from '@shared/git-status'
import type { AiProvider, GitCommit, GitFileKind, GitHubInfo, GitStatus, PullRequest } from '@shared/types'
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
  const hasConflicts = (status?.conflicts.length ?? 0) > 0
  const prConflicts = github?.prs.some((p) => p.hasConflicts) ?? false
  const dirty = status && !status.clean
  return hasConflicts || prConflicts ? C.red : dirty ? C.yellow : C.green
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
      background: 'rgba(239,68,68,0.1)',
      border: '1px solid rgba(239,68,68,0.35)',
      fontSize: 11.5,
      color: C.red
    }
  }
  const green = variant === 'success'
  return {
    marginBottom: 10,
    padding: '8px 10px',
    borderRadius: 7,
    background: green ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
    border: green ? '1px solid rgba(34,197,94,0.25)' : '1px solid rgba(239,68,68,0.25)',
    fontSize: 11.5,
    color: green ? C.textSoft : C.red,
    lineHeight: 1.45,
    ...(green ? { fontFamily: MONO } : {})
  }
}

function PrRow({ pr }: { pr: PullRequest }) {
  const rollup =
    pr.checksFailed > 0
      ? { label: `${pr.checksFailed} failed`, color: C.red }
      : pr.checksPending > 0
        ? { label: `${pr.checksPending} pending`, color: C.yellow }
        : pr.hasChecks
          ? { label: 'Checks passed', color: C.green }
          : { label: 'No checks', color: C.faint }

  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      className="bf-focus"
      title={pr.title}
      style={{
        display: 'block',
        padding: '8px 10px',
        borderRadius: 7,
        textDecoration: 'none',
        color: C.textSoft,
        background: 'rgba(255,255,255,0.02)',
        border: `1px solid ${C.cardBorder}`
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
        <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.accentBright }}>#{pr.number}</span>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1
          }}
        >
          {pr.title}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5, color: C.textMuted }}>
        <span style={{ fontFamily: MONO }}>{pr.headRef}</span>
        {pr.hasConflicts && (
          <span style={{ color: C.red, fontWeight: 600 }}>Conflicts</span>
        )}
        <span style={{ marginLeft: 'auto', color: rollup.color }}>{rollup.label}</span>
      </div>
    </a>
  )
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

function PullRequestsBlock({ github }: { github: GitHubInfo | null }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={sectionLabel}>PULL REQUESTS</div>
      {!github && <div style={{ fontSize: 11.5, color: C.faint }}>Loading…</div>}
      {github && !github.available && (
        <div style={{ fontSize: 11.5, color: C.textMuted, lineHeight: 1.45 }}>{github.message}</div>
      )}
      {github?.available && github.prs.length === 0 && (
        <div style={{ fontSize: 11.5, color: C.faint }}>No open pull requests</div>
      )}
      {github?.available && github.prs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {github.prs.map((pr) => (
            <PrRow key={pr.number} pr={pr} />
          ))}
        </div>
      )}
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

function gitActionState(
  status: GitStatus | null,
  github: GitHubInfo | null,
  gitAction: 'commit' | 'push' | null
): { hasConflicts: boolean; prConflicts: boolean; canCommit: boolean; canPush: boolean } {
  const hasConflicts = (status?.conflicts.length ?? 0) > 0
  const prConflicts = github?.prs.some((p) => p.hasConflicts) ?? false
  return {
    hasConflicts,
    prConflicts,
    canCommit: !!status && !commitBlockReason(status) && !gitAction,
    canPush: !!status && !pushBlockReason(status) && !gitAction
  }
}

function ConflictAlert({
  hasConflicts,
  prConflicts
}: {
  hasConflicts: boolean
  prConflicts: boolean
}) {
  if (!hasConflicts && !prConflicts) return null
  return (
    <div style={alertBox('conflict')}>
      {hasConflicts
        ? 'Merge conflicts in the working tree — resolve before committing.'
        : 'An open pull request has merge conflicts.'}
    </div>
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

  const { hasConflicts, prConflicts, canCommit, canPush } = gitActionState(
    status,
    github,
    gitAction
  )
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
          background: '#111827',
          border: `1px solid ${C.cardBorder}`,
          borderRadius: 10,
          boxShadow: '0 18px 44px rgba(0,0,0,0.55)',
          overflow: 'hidden'
        }}
      >
        <GitPanelHeader loading={loading} onRefresh={() => void refresh()} />

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 10px 12px' }}>
          <ConflictAlert hasConflicts={hasConflicts} prConflicts={prConflicts} />
          <PullRequestsBlock github={github} />
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
