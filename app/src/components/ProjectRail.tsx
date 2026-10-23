import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { GitInfo, Project } from '@shared/types'
import { groupOpenProjects, shortPath } from '@shared/project-groups'
import { C, MONO, ELLIPSIS } from '../theme'
import {
  CHROME_ROW,
  SIDE_RAIL_WIDTH,
  sidePanelShellStyle
} from './side-panel'
import {
  BranchIcon,
  ChevronLeft,
  ChevronRight,
  ClearChatIcon,
  PinIcon,
  RefreshIcon,
  Spinner
} from './icons'

const api = window.farol

const PANEL_WIDTH = 250
/** The leaving layer fades quickly; the arriving one starts just before it is gone. */
const FADE_OUT_MS = 100
const FADE_IN_MS = 140
const FADE_IN_DELAY_MS = 90

/** `inert` keeps the hidden layer out of focus order; React 18's types do not know it yet. */
function inertWhen(on: boolean): Record<string, string> {
  return on ? { inert: '' } : {}
}
const SOFT = 'oklch(1 0 0 / 0.06)'
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

function iconButton(size: number, color: string = C.faint): React.CSSProperties {
  return {
    ...noDrag,
    width: size,
    height: size,
    flex: 'none',
    borderRadius: size > 22 ? 7 : 5,
    border: 0,
    background: 'transparent',
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    color
  }
}

interface Props {
  projects: Project[]
  activePath: string | null
  /** Project paths with active agent or pipeline work. */
  busyPaths?: ReadonlySet<string>
  /** Finished chats with updates the user has not opened yet. */
  unreadPaths?: ReadonlySet<string>
  onSelect: (path: string) => void
  onClose: (path: string) => void
  /** Open a repository as a project. */
  onOpenProject?: () => void
  /** Open the branch/worktree dialog for a project in this repo group. */
  onNewBranch: (projectPath: string) => void
  /** Select this checkout and clear its chat to start fresh. */
  onNewChat: (projectPath: string) => void
  collapsed: boolean
  onSetCollapsed: (collapsed: boolean) => void
  /** Source Control trigger for the active checkout. */
  gitAnchorRef?: React.RefObject<HTMLButtonElement>
  showGit?: boolean
  gitOpen?: boolean
  gitDotColor?: string
  /** "3 changes · 16 ahead". */
  gitSummary?: string
  onGitToggle?: () => void
  gitBusy?: boolean
  gitPulling?: boolean
  gitPullResult?: { ok: boolean; message: string }
  onGitPull?: () => void
}

function PinButton({ pinned, onClick }: { pinned: boolean; onClick: () => void }) {
  const label = pinned ? 'Keep projects open' : 'Keep collapsed, reveal on hover'
  return (
    <button
      type="button"
      className="bf-focus bf-icon-btn"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={pinned}
      style={{
        ...iconButton(26),
        background: pinned ? 'oklch(0.91 0.19 115 / 0.14)' : 'transparent',
        color: pinned ? C.accent : C.faint
      }}
    >
      <PinIcon size={12} />
    </button>
  )
}

type Activity = 'busy' | 'unread' | 'idle'

function activityOf(busy: boolean, unread: boolean): Activity {
  return busy ? 'busy' : unread ? 'unread' : 'idle'
}

/** Status dot: lime with a halo while the agent works, lavender for unread replies, faint otherwise. */
function ActivityMark({ activity, size }: { activity: Activity; size: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: '50%',
        background: activity === 'busy' ? C.accent : activity === 'unread' ? C.purpleSoft : C.border,
        boxShadow: activity === 'busy' ? '0 0 0 3px oklch(0.91 0.19 115 / 0.18)' : 'none',
        animation: activity === 'busy' ? 'bfpulse 1.1s ease-in-out infinite' : 'none'
      }}
    />
  )
}

function activityTip(display: string, busy: boolean, unread: boolean): string {
  if (busy) return `${display}: work in progress`
  if (unread) return `${display}: unread chat updates`
  return display
}

function activityMeta(path: string, busy: boolean, unread: boolean): string {
  return busy ? 'Agent working…' : unread ? 'New replies' : shortPath(path)
}

export default function ProjectRail({
  projects,
  activePath,
  busyPaths,
  unreadPaths,
  onSelect,
  onClose,
  onNewBranch,
  onNewChat,
  collapsed,
  onSetCollapsed,
  gitAnchorRef,
  showGit,
  gitOpen,
  gitDotColor,
  gitSummary,
  onOpenProject,
  onGitToggle,
  gitBusy,
  gitPulling,
  gitPullResult,
  onGitPull
}: Props) {
  const agentBusy = (path: string): boolean => !!busyPaths?.has(path)
  const agentUnread = (path: string): boolean => !!unreadPaths?.has(path)
  const [gitByPath, setGitByPath] = useState<Record<string, GitInfo>>({})
  const [groupCollapsed, setGroupCollapsed] = useState<Record<string, boolean>>({})
  const [pinned, setPinned] = useState(false)
  const [hover, setHover] = useState(false)
  const peek = pinned && (hover || !!gitOpen)
  const slim = (collapsed || pinned) && !peek
  const shellStyle = {
    ...sidePanelShellStyle(slim, { panelWidth: PANEL_WIDTH, railWidth: SIDE_RAIL_WIDTH }),
    marginTop: pinned && peek ? 0 : CHROME_ROW,
    ...(pinned && peek
      ? {
          position: 'absolute' as const,
          inset: `${CHROME_ROW}px auto 0 0`,
          width: PANEL_WIDTH,
          zIndex: 50,
          boxShadow: '12px 0 32px rgba(0,0,0,.45)'
        }
      : pinned
        ? { position: 'relative' as const, flex: 1, minHeight: 0 }
        : { position: 'relative' as const })
  }

  const releasePin = (nextCollapsed: boolean): void => {
    setPinned(false)
    setHover(false)
    onSetCollapsed(nextCollapsed)
  }

  const togglePin = (): void => {
    if (pinned) {
      releasePin(false)
      return
    }
    setPinned(true)
    setHover(!slim)
    onSetCollapsed(true)
  }

  const host = (node: ReactNode): ReactNode =>
    pinned ? (
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: 'relative',
          flex: 'none',
          alignSelf: 'stretch',
          display: 'flex',
          flexDirection: 'column',
          width: SIDE_RAIL_WIDTH,
          zIndex: peek ? 50 : undefined
        }}
      >
        {node}
      </div>
    ) : (
      node
    )

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const entries = await Promise.all(
        projects.map(async (project) => {
          const info = await api.git.info(project.path)
          return [project.path, info] as const
        })
      )
      if (cancelled) return
      setGitByPath(Object.fromEntries(entries))
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [projects])

  useEffect(() => {
    return api.git.onChanged((changed) => {
      setGitByPath((prev) => ({ ...prev, [changed.projectPath]: changed.info }))
    })
  }, [])

  const groups = useMemo(
    () => groupOpenProjects(projects, gitByPath),
    [projects, gitByPath]
  )

  const gitStatusLabel = !gitDotColor
    ? ''
    : gitDotColor === C.green
      ? 'working tree clean'
      : gitDotColor === C.red
        ? 'conflicts present'
        : 'working tree has changes'

  const gitButton = (size: 'rail' | 'row') => (
    <button
      ref={gitAnchorRef}
      type="button"
      className="bf-focus bf-icon-btn"
      onClick={onGitToggle}
      title="Open Source Control"
      aria-label={gitStatusLabel ? `Open Source Control: ${gitStatusLabel}` : 'Open Source Control'}
      aria-expanded={gitOpen}
      style={{
        ...noDrag,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 9,
        cursor: 'pointer',
        color: C.textRow,
        font: 'inherit',
        textAlign: 'left',
        ...(size === 'rail'
          ? { width: 32, height: 32, flex: 'none', borderRadius: 8, border: `1px solid ${gitOpen ? C.accent : 'oklch(1 0 0 / 0.08)'}`, background: 'transparent' }
          : { flex: 1, minWidth: 0, justifyContent: 'flex-start', padding: '7px 10px', borderRadius: 8, border: 0, background: gitOpen ? 'oklch(1 0 0 / 0.05)' : 'transparent' })
      }}
    >
      <BranchIcon size={13} color={C.textRow} style={{ flex: 'none' }} />
      {size === 'row' && (
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 12.5, fontWeight: 500, color: C.text }}>Source Control</span>
          <span style={{ display: 'block', marginTop: 1, fontSize: 11, color: C.faint, ...ELLIPSIS }}>
            {gitPulling ? 'Pulling…' : gitSummary}
          </span>
        </span>
      )}
      {gitDotColor && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: gitDotColor,
            flex: 'none',
            ...(size === 'rail' ? { position: 'absolute', top: 5, right: 5 } : {})
          }}
        />
      )}
    </button>
  )

  const pullButton = onGitPull && (
    <button
      type="button"
      className="bf-focus bf-icon-btn"
      disabled={gitBusy}
      aria-label={gitPulling ? 'Pulling current branch' : 'Pull and refresh current branch'}
      title={gitPulling ? 'Pulling current branch…' : gitPullResult?.message || 'Pull current branch'}
      onClick={onGitPull}
      style={{
        ...iconButton(34, !gitPulling && gitPullResult?.ok === false ? C.red : C.textMuted),
        borderRadius: 8,
        opacity: gitBusy && !gitPulling ? 0.5 : 1
      }}
    >
      {gitPulling ? <Spinner size={13} /> : <RefreshIcon size={13} />}
    </button>
  )

  // One aside whose width animates; the rail and the full panel sit stacked inside
  // and cross-fade, so collapsing never swaps elements mid-motion.
  const layer = (visible: boolean): React.CSSProperties => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    display: 'flex',
    flexDirection: 'column',
    opacity: visible ? 1 : 0,
    visibility: visible ? 'visible' : 'hidden',
    pointerEvents: visible ? 'auto' : 'none',
    transition: visible
      ? `opacity ${FADE_IN_MS}ms ease ${FADE_IN_DELAY_MS}ms, visibility 0s linear 0s`
      : `opacity ${FADE_OUT_MS}ms ease 0s, visibility 0s linear ${FADE_OUT_MS}ms`
  })

  return host(
    <aside aria-label="Projects" className="bf-side-panel" style={shellStyle}>
      <div aria-hidden={!slim} {...inertWhen(!slim)} style={{ ...layer(slim), width: SIDE_RAIL_WIDTH, alignItems: 'center', gap: 14, padding: '12px 0', boxSizing: 'border-box' }}>
        <button
          type="button"
          className="bf-focus bf-icon-btn"
          onClick={() => releasePin(false)}
          title={pinned ? 'Keep projects open' : 'Show projects'}
          aria-label={pinned ? 'Keep projects open' : 'Show projects'}
          style={iconButton(28, C.textMuted)}
        >
          <ChevronRight size={10} />
        </button>
        <PinButton pinned={pinned} onClick={togglePin} />
        <div style={{ width: 20, height: 1, background: 'oklch(1 0 0 / 0.08)' }} />

        {groups.map((group, index) => (
          <Fragment key={group.id}>
            {index > 0 && <div style={{ width: 12, height: 1, background: 'oklch(1 0 0 / 0.08)' }} />}
            {group.projects.map(({ project }) => {
          const busy = agentBusy(project.path)
          const unread = agentUnread(project.path)
          const on = project.path === activePath
          return (
            <button
              key={project.path}
              type="button"
              className="bf-focus bf-icon-btn"
              onClick={() => {
                onSelect(project.path)
                if (!pinned) onSetCollapsed(false)
              }}
              title={activityTip(project.display, busy, unread)}
              aria-label={activityTip(project.display, busy, unread)}
              style={{ ...iconButton(28), background: on ? 'oklch(1 0 0 / 0.08)' : 'transparent' }}
            >
              <ActivityMark activity={activityOf(busy, unread)} size={8} />
            </button>
          )
            })}
          </Fragment>
        ))}

        <span style={{ flex: 1 }} />
        {showGit && onGitToggle && gitButton('rail')}
      </div>
      <div aria-hidden={slim} {...inertWhen(slim)} style={{ ...layer(!slim), width: PANEL_WIDTH }}>
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 4, padding: '12px 10px 12px 16px' }}>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>Projects</span>
          <PinButton pinned={pinned} onClick={togglePin} />
          {onOpenProject && (
            <button
              type="button"
              className="bf-focus bf-icon-btn"
              onClick={onOpenProject}
              title="Open project"
              aria-label="Open project"
              style={{ ...iconButton(26, C.textSoft), fontSize: 16, lineHeight: 1 }}
            >
              +
            </button>
          )}
          <button
            type="button"
            className="bf-focus bf-icon-btn"
            onClick={() => releasePin(true)}
            title="Collapse"
            aria-label="Collapse projects panel"
            style={iconButton(26)}
          >
            <ChevronLeft size={10} />
          </button>
        </div>

        <div
          style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 8px 12px', display: 'flex', flexDirection: 'column', gap: 14, ...noDrag }}
        >
          {groups.map((group) => {
            const isCollapsed = groupCollapsed[group.id]
            const hasRepo = group.projects.some((p) => gitByPath[p.project.path]?.isRepo)
            return (
              <div key={group.id} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px' }}>
                  <button
                    type="button"
                    className="bf-focus"
                    aria-expanded={!isCollapsed}
                    title={isCollapsed ? 'Expand' : 'Collapse'}
                    onClick={() => setGroupCollapsed((prev) => ({ ...prev, [group.id]: !prev[group.id] }))}
                    style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, padding: 0, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left' }}
                  >
                    <ChevronRight
                      size={8}
                      color={C.faint}
                      style={{ flex: 'none', transform: isCollapsed ? 'none' : 'rotate(90deg)', transition: 'transform .12s' }}
                    />
                    <span title={group.label} style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.04em', color: C.textMuted, ...ELLIPSIS }}>
                      {group.label}
                    </span>
                  </button>
                  {hasRepo && (
                    <button
                      type="button"
                      className="bf-focus bf-icon-btn"
                      title="Open branch as project"
                      aria-label="Open branch as project"
                      onClick={() => {
                        const preferred =
                          group.projects.find((p) => p.project.path === activePath)?.project.path ??
                          group.projects[0]?.project.path
                        if (preferred) onNewBranch(preferred)
                      }}
                      style={{ ...iconButton(20), fontSize: 14, lineHeight: 1 }}
                    >
                      +
                    </button>
                  )}
                </div>

                {!isCollapsed &&
                  group.projects.map(({ project, branch }) => {
                    const active = project.path === activePath
                    const busy = agentBusy(project.path)
                    const unread = agentUnread(project.path)
                    return (
                      <div
                        key={project.path}
                        role="button"
                        tabIndex={0}
                        className="bf-focus bf-reveal-host bf-proj-row"
                        title={activityTip(project.display, busy, unread)}
                        onClick={() => onSelect(project.path)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onSelect(project.path)
                          }
                        }}
                        onAuxClick={(e) => {
                          if (e.button === 1) onClose(project.path)
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '7px 8px 7px 22px',
                          borderRadius: 7,
                          background: active ? 'oklch(0.26 0.005 95)' : 'transparent',
                          cursor: 'pointer',
                          minWidth: 0
                        }}
                      >
                        <ActivityMark activity={activityOf(busy, unread)} size={7} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontFamily: MONO, fontSize: 12, fontWeight: active ? 600 : 400, color: active ? C.text : C.textRow, ...ELLIPSIS }}>
                            {branch}
                          </span>
                          <span style={{ display: 'block', marginTop: 1, fontSize: 11, color: 'oklch(0.5 0.006 95)', ...ELLIPSIS }}>
                            {activityMeta(project.path, busy, unread)}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="bf-focus bf-icon-btn bf-reveal"
                          title="Clear this branch's chat (does not create a second chat)"
                          aria-label="Clear this branch's chat"
                          onClick={(e) => {
                            e.stopPropagation()
                            onNewChat(project.path)
                          }}
                          style={iconButton(18)}
                        >
                          <ClearChatIcon size={12} />
                        </button>
                        <button
                          type="button"
                          className="bf-focus bf-icon-btn bf-reveal"
                          title="Close project"
                          aria-label="Close project"
                          onClick={(e) => {
                            e.stopPropagation()
                            onClose(project.path)
                          }}
                          style={{ ...iconButton(18), fontSize: 13, lineHeight: 1 }}
                        >
                          ×
                        </button>
                      </div>
                    )
                  })}
              </div>
            )
          })}
        </div>

        {showGit && onGitToggle && (
          <div style={{ flex: 'none', display: 'flex', gap: 6, padding: 10, borderTop: `1px solid ${SOFT}`, ...noDrag }}>
            {gitButton('row')}
            {pullButton}
          </div>
        )}
      </div>
    </aside>
  )
}
