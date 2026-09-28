import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { GitInfo, Project } from '@shared/types'
import { groupOpenProjects, shortPath } from '@shared/project-groups'
import { C, UI, ELLIPSIS } from '../theme'
import {
  CHROME_ROW,
  PANEL_INSET,
  RailLabel,
  SIDE_RAIL_WIDTH,
  sidePanelShellStyle,
  useCollapseRail
} from './side-panel'
import {
  BranchIcon,
  CaretLeft,
  CaretRight,
  ChevronDown,
  ChevronRight,
  ClearChatIcon,
  GitIcon,
  PinIcon,
  ProjectIcon,
  RefreshIcon,
  Spinner
} from './icons'

const api = window.farol

const PANEL_WIDTH = 225
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties
const iconBtn: React.CSSProperties = {
  ...noDrag,
  width: 26,
  height: 26,
  borderRadius: 6,
  border: 0,
  background: 'transparent',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  color: C.textMuted
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
        ...iconBtn,
        background: pinned ? 'rgba(214, 242, 58, 0.12)' : 'transparent',
        color: pinned ? C.accent : C.textMuted
      }}
    >
      <PinIcon size={13} />
    </button>
  )
}

/** Status dot — green pulse while busy, lime until the chat is opened, then off. */
function ChatActivityDot({ busy, unread }: { busy: boolean; unread: boolean }) {
  const title = busy ? 'Work in progress' : unread ? 'Unread chat updates' : undefined
  return (
    <span
      role={title ? 'img' : undefined}
      title={title}
      aria-label={title}
      style={{
        width: 7,
        height: 7,
        flex: 'none',
        borderRadius: '50%',
        background: busy ? C.green : unread ? C.accent : C.fainter,
        animation: busy ? 'bfpulse 1.1s ease-in-out infinite' : 'none'
      }}
    />
  )
}

function activityTip(display: string, busy: boolean, unread: boolean): string {
  if (busy) return `${display}: work in progress`
  if (unread) return `${display}: unread chat updates`
  return display
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
  const { showRail, onWidthTransitionEnd } = useCollapseRail(collapsed || pinned)
  const rail = slim && (pinned || showRail)
  const chrome = `${CHROME_ROW + PANEL_INSET}px`
  const shellStyle = {
    ...sidePanelShellStyle(slim, { panelWidth: PANEL_WIDTH, railWidth: SIDE_RAIL_WIDTH }),
    margin: pinned && peek ? 0 : `${chrome} 0 ${PANEL_INSET}px ${PANEL_INSET}px`,
    ...(pinned && peek
      ? {
          position: 'absolute' as const,
          inset: `${chrome} auto ${PANEL_INSET}px ${PANEL_INSET}px`,
          width: PANEL_WIDTH,
          zIndex: 50
        }
      : pinned
        ? { flex: 1, minHeight: 0 }
        : {})
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
    setHover(!rail)
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
          width: SIDE_RAIL_WIDTH + PANEL_INSET,
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

  const activeGroup = groups.find((g) => g.projects.some((p) => p.project.path === activePath))
  const activeBranch =
    activeGroup?.projects.find((p) => p.project.path === activePath)?.branch ?? ''
  const gitStatusLabel = !gitDotColor
    ? ''
    : gitDotColor === C.green
      ? 'working tree clean'
      : gitDotColor === C.red
        ? 'conflicts present'
        : 'working tree has changes'

  const gitFooter = showGit && onGitToggle && (
    <div
      style={{
        flex: 'none',
        padding: rail ? '0 0 12px' : '0 8px 12px',
        display: 'flex',
        justifyContent: 'center',
        WebkitAppRegion: 'no-drag'
      } as React.CSSProperties}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: rail ? 'column' : 'row',
          gap: 6,
          width: rail ? 34 : '100%'
        }}
      >
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
          width: rail ? 34 : undefined,
          flex: rail ? 'none' : 1,
          height: 34,
          borderRadius: 8,
          border: `1px solid ${gitOpen ? C.accent : C.border}`,
          background: gitOpen ? 'rgba(214, 242, 58,0.12)' : 'rgba(255,255,255,0.03)',
          color: C.textSoft,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          cursor: 'pointer',
          position: 'relative'
        }}
      >
        {rail ? (
          <GitIcon size={14} color={C.textMuted} />
        ) : (
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em' }}>Git</span>
        )}
        {gitDotColor && (
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: gitDotColor,
              flex: 'none',
              ...(rail
                ? { position: 'absolute', top: 6, right: 6 }
                : { marginLeft: 'auto', marginRight: 2 })
            }}
          />
        )}
      </button>
      {onGitPull && (
        <button
          type="button"
          className="bf-focus bf-icon-btn"
          disabled={gitBusy}
          aria-label={gitPulling ? 'Pulling current branch' : 'Pull and refresh current branch'}
          title={gitPulling ? 'Pulling current branch…' : gitPullResult?.message || 'Pull and refresh current branch'}
          onClick={onGitPull}
          style={{
            ...iconBtn,
            width: 34,
            height: 34,
            flex: 'none',
            border: `1px solid ${C.border}`,
            color: !gitPulling && gitPullResult?.ok === false ? C.red : C.textMuted,
            opacity: gitBusy && !gitPulling ? 0.5 : 1
          }}
        >
          {gitPulling ? <Spinner size={14} /> : <RefreshIcon size={14} />}
        </button>
      )}
      </div>
    </div>
  )

  if (rail) {
    return host(
      <aside
        aria-label="Projects"
        className="bf-side-panel"
        style={{
          ...shellStyle,
          alignItems: 'center',
          gap: 14,
          padding: '11px 0 14px'
        }}
      >
        <button
          type="button"
          className="bf-focus bf-icon-btn"
          onClick={() => releasePin(false)}
          title={pinned ? 'Keep projects open' : 'Show projects'}
          aria-label={pinned ? 'Keep projects open' : 'Show projects'}
          style={{ ...iconBtn, width: 30, height: 30, borderRadius: 8 }}
        >
          <CaretRight />
        </button>
        <PinButton pinned={pinned} onClick={togglePin} />
        <div style={{ width: 22, height: 1, background: C.border }} />

        {activeGroup && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <ProjectIcon size={14} color={C.accent} />
            <RailLabel color={C.text} weight={500}>
              {activeGroup.label}
            </RailLabel>
            {activeBranch && <RailLabel color={C.textMuted}>{activeBranch}</RailLabel>}
          </div>
        )}

        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, alignItems: 'center' }}>
          {projects.map((project) => {
            const busy = agentBusy(project.path)
            const unread = agentUnread(project.path)
            return (
              <button
                key={project.path}
                type="button"
                className="bf-focus"
                onClick={() => {
                  onSelect(project.path)
                  if (!pinned) onSetCollapsed(false)
                }}
                title={activityTip(project.display, busy, unread)}
                aria-label={activityTip(project.display, busy, unread)}
                style={{
                  cursor: 'pointer',
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  display: 'grid',
                  placeItems: 'center'
                }}
              >
                <ChatActivityDot busy={busy} unread={unread} />
              </button>
            )
          })}
        </div>
        {gitFooter}
      </aside>
    )
  }

  return host(
    <aside
      aria-label="Projects"
      className="bf-side-panel"
      style={shellStyle}
      onTransitionEnd={onWidthTransitionEnd}
    >
      <div
        style={{
          width: PANEL_WIDTH,
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column'
        }}
      >
      <div
        style={{
          height: 44,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 7px 0 12px',
          WebkitAppRegion: 'drag'
        } as React.CSSProperties}
      >
        <span style={{ flex: 1, fontSize: 10, fontWeight: 600, letterSpacing: '0.09em', color: C.textMuted }}>
          PROJECTS
        </span>
        <PinButton pinned={pinned} onClick={togglePin} />
        <button
          type="button"
          className="bf-focus bf-icon-btn"
          onClick={() => releasePin(true)}
          title="Collapse panel"
          aria-label="Collapse projects panel"
          style={iconBtn}
        >
          <CaretLeft />
        </button>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '0 8px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          WebkitAppRegion: 'no-drag'
        } as React.CSSProperties}
      >
        {groups.map((group) => {
          const isCollapsed = groupCollapsed[group.id]
          const hasRepo = group.projects.some((p) => gitByPath[p.project.path]?.isRepo)
          return (
            <div key={group.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 6px',
                  borderRadius: 6,
                  color: C.textMuted
                }}
              >
                <button
                  type="button"
                  className="bf-icon-btn"
                  title={isCollapsed ? 'Expand' : 'Collapse'}
                  onClick={() =>
                    setGroupCollapsed((prev) => ({ ...prev, [group.id]: !prev[group.id] }))
                  }
                  style={{
                    width: 20,
                    height: 20,
                    border: 0,
                    background: 'transparent',
                    color: C.textMuted,
                    display: 'grid',
                    placeItems: 'center',
                    cursor: 'pointer',
                    flex: 'none'
                  }}
                >
                  {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                </button>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12,
                    fontWeight: 600,
                    color: C.textSoft,
                    ...ELLIPSIS
                  }}
                  title={group.label}
                >
                  {group.label}
                </span>
                {hasRepo && (
                  <button
                    type="button"
                    className="bf-icon-btn"
                    title="Open branch as project"
                    onClick={() => {
                      const preferred =
                        group.projects.find((p) => p.project.path === activePath)?.project.path ??
                        group.projects[0]?.project.path
                      if (preferred) onNewBranch(preferred)
                    }}
                    style={{
                      width: 22,
                      height: 22,
                      border: 0,
                      background: 'transparent',
                      color: C.textMuted,
                      display: 'grid',
                      placeItems: 'center',
                      cursor: 'pointer',
                      flex: 'none'
                    }}
                  >
                    <BranchIcon size={12} />
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
                      className="bf-focus"
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
                        gap: 8,
                        marginLeft: 10,
                        padding: '6px 8px',
                        borderRadius: 6,
                        background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
                        color: active ? C.text : C.textMuted,
                        cursor: 'pointer',
                        minWidth: 0
                      }}
                    >
                      <ChatActivityDot busy={busy} unread={unread} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 12,
                            fontWeight: active ? 600 : 500,
                            ...ELLIPSIS
                          }}
                        >
                          {branch}
                        </span>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 10,
                            fontFamily: UI,
                            color: C.faint,
                            ...ELLIPSIS
                          }}
                        >
                          {shortPath(project.path)}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="bf-icon-btn"
                        title="Clear this branch's chat (does not create a second chat)"
                        aria-label="Clear this branch's chat"
                        onClick={(e) => {
                          e.stopPropagation()
                          onNewChat(project.path)
                        }}
                        style={{
                          flex: 'none',
                          width: 18,
                          height: 18,
                          border: 0,
                          background: 'transparent',
                          color: C.textMuted,
                          cursor: 'pointer',
                          display: 'grid',
                          placeItems: 'center',
                          opacity: active ? 1 : 0.7
                        }}
                      >
                        <ClearChatIcon size={13} color={C.textMuted} />
                      </button>
                      <button
                        type="button"
                        className="bf-tab-close"
                        title="Close project"
                        onClick={(e) => {
                          e.stopPropagation()
                          onClose(project.path)
                        }}
                        style={{
                          flex: 'none',
                          width: 16,
                          height: 16,
                          border: 0,
                          background: 'transparent',
                          color: C.textMuted,
                          fontSize: 13,
                          cursor: 'pointer',
                          opacity: active ? 1 : 0.55
                        }}
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

      {gitFooter}
      </div>
    </aside>
  )
}
