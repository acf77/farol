import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import type { AiProvider, GitFileKind, GitHubInfo, GitStatus, PullRequest } from '@shared/types'
import { useGitPanel } from '../hooks/useGitPanel'
import { C, MONO } from '../theme'
import { Button } from './controls'
import { SIDE_PANEL_WIDTH } from './side-panel'
import { CheckIcon, GitIcon, RetryIcon, Spinner } from './icons'

interface Props extends ReturnType<typeof useGitPanel> {
  branch: string
  provider: AiProvider
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
  status,
  github,
  loading,
  committing,
  lastMessage,
  error,
  refresh,
  aiCommit,
  open,
  onClose,
  anchorRef
}: Props) {
  const pos = usePopoverPosition(anchorRef, open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !pos) return null

  const hasConflicts = (status?.conflicts.length ?? 0) > 0
  const prConflicts = github?.prs.some((p) => p.hasConflicts) ?? false
  const dirty = status && !status.clean
  const canCommit = !!dirty && !hasConflicts && !committing

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
          {(hasConflicts || prConflicts) && (
            <div style={alertBox('conflict')}>
              {hasConflicts
                ? 'Merge conflicts in the working tree — resolve before committing.'
                : 'An open pull request has merge conflicts.'}
            </div>
          )}

          <PullRequestsBlock github={github} />
          <ChangesBlock branch={branch} status={status} />
          {error && <div style={alertBox('error')}>{error}</div>}
          {lastMessage && <div style={alertBox('success')}>{lastMessage}</div>}
        </div>

        <div
          style={{
            flex: 'none',
            padding: '10px 12px 12px',
            borderTop: `1px solid ${C.cardBorder}`
          }}
        >
          <Button
            variant="primary"
            size="md"
            disabled={!canCommit}
            onClick={() => void aiCommit()}
            title={`Stage all, generate a message with ${provider}, and commit`}
            style={{ width: '100%' }}
          >
            {committing ? (
              <>
                <Spinner /> Committing…
              </>
            ) : (
              'Commit with AI'
            )}
          </Button>
        </div>
      </div>
    </>
  )
}
