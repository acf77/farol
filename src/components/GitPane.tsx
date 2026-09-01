import type { CSSProperties } from 'react'
import type { AiProvider, GitFileKind, GitHubInfo, GitStatus, PullRequest } from '@shared/types'
import { useGitPanel } from '../hooks/useGitPanel'
import { C, MONO } from '../theme'
import { Button } from './controls'
import {
  RailLabel,
  SIDE_PANEL_WIDTH,
  sidePanelShellStyle,
  useCollapseRail
} from './side-panel'
import { CaretLeft, CaretRight, CheckIcon, GitIcon, RetryIcon, Spinner } from './icons'

interface Props extends ReturnType<typeof useGitPanel> {
  branch: string
  provider: AiProvider
  collapsed: boolean
  onSetCollapsed: (collapsed: boolean) => void
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

function GitCollapsedRail({
  shellStyle,
  dotColor,
  onExpand
}: {
  shellStyle: CSSProperties
  dotColor: string
  onExpand: () => void
}) {
  return (
    <div
      className="bf-side-panel"
      style={{ ...shellStyle, cursor: 'pointer', alignItems: 'center', paddingTop: 12, gap: 10 }}
      onClick={onExpand}
      title="Expand git panel"
    >
      <GitIcon size={14} color={C.textMuted} />
      <RailLabel color={C.textMuted}>GIT</RailLabel>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, flex: 'none' }} />
      <button
        type="button"
        className="bf-focus bf-icon-btn"
        onClick={(e) => {
          e.stopPropagation()
          onExpand()
        }}
        title="Expand git panel"
        aria-label="Expand git panel"
        style={{ ...iconBtn, marginTop: 'auto', marginBottom: 10 }}
      >
        <CaretLeft />
      </button>
    </div>
  )
}

function GitPanelHeader({
  loading,
  onRefresh,
  onCollapse
}: {
  loading: boolean
  onRefresh: () => void
  onCollapse: () => void
}) {
  return (
    <div
      style={{
        height: 44,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 7px 0 12px'
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
      <button
        type="button"
        className="bf-focus bf-icon-btn"
        onClick={onCollapse}
        title="Collapse panel"
        aria-label="Collapse git panel"
        style={iconBtn}
      >
        <CaretRight />
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
  collapsed,
  onSetCollapsed
}: Props) {
  const { showRail, onWidthTransitionEnd } = useCollapseRail(collapsed)
  const shellStyle = sidePanelShellStyle(collapsed, { animate: true })

  const hasConflicts = (status?.conflicts.length ?? 0) > 0
  const prConflicts = github?.prs.some((p) => p.hasConflicts) ?? false
  const dirty = status && !status.clean
  const canCommit = !!dirty && !hasConflicts && !committing
  const dotColor = hasConflicts || prConflicts ? C.red : dirty ? C.yellow : C.green

  if (showRail) {
    return (
      <GitCollapsedRail
        shellStyle={shellStyle}
        dotColor={dotColor}
        onExpand={() => onSetCollapsed(false)}
      />
    )
  }

  return (
    <div
      className="bf-side-panel"
      style={shellStyle}
      onTransitionEnd={onWidthTransitionEnd}
    >
      <div
        style={{
          width: SIDE_PANEL_WIDTH,
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <GitPanelHeader loading={loading} onRefresh={() => void refresh()} onCollapse={() => onSetCollapsed(true)} />

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 10px 12px' }}>
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
    </div>
  )
}
