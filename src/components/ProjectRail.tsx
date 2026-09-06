import { useEffect, useMemo, useState } from 'react'
import type { GitInfo, Project } from '@shared/types'
import { groupOpenProjects } from '@shared/project-groups'
import { C, UI } from '../theme'
import { CHROME_ROW, PANEL_INSET, RailLabel, sidePanelShellStyle, useCollapseRail } from './side-panel'
import {
  BranchIcon,
  CaretLeft,
  CaretRight,
  ChevronDown,
  ChevronRight,
  ClearChatIcon,
  GitIcon,
  ProjectIcon
} from './icons'

const api = window.farol

const PANEL_WIDTH = 300
const RAIL_WIDTH = 54
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

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
  /** Anchor for the git popover on the active repo checkout. */
  gitAnchorRef?: React.RefObject<HTMLButtonElement>
  showGit?: boolean
  gitOpen?: boolean
  gitDotColor?: string
  onGitToggle?: () => void
}

/** Status dot — green pulse while busy, lime until the chat is opened, then off. */
function ChatActivityDot({ busy, unread }: { busy: boolean; unread: boolean }) {
  const title = busy ? 'Work in progress' : unread ? 'Unread chat updates' : undefined
  return (
    <span
      title={title}
      aria-label={title}
      style={{
        width: 7,
        height: 7,
        flex: 'none',
        borderRadius: '50%',
        background: busy ? C.green : unread ? C.accent : C.fainter,
        boxShadow: busy ? `0 0 6px ${C.green}` : unread ? `0 0 6px ${C.accent}` : undefined,
        animation: busy ? 'bfpulse 1.1s ease-in-out infinite' : 'none'
      }}
    />
  )
}

function shortPath(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts.slice(-2).join('/')
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
  onGitToggle
}: Props) {
  const agentBusy = (path: string): boolean => !!busyPaths?.has(path)
  const agentUnread = (path: string): boolean => !!unreadPaths?.has(path)
  const [gitByPath, setGitByPath] = useState<Record<string, GitInfo>>({})
  const [groupCollapsed, setGroupCollapsed] = useState<Record<string, boolean>>({})
  const { showRail, onWidthTransitionEnd } = useCollapseRail(collapsed)
  const shellStyle = {
    ...sidePanelShellStyle(collapsed, { panelWidth: PANEL_WIDTH, railWidth: RAIL_WIDTH }),
    margin: `${CHROME_ROW + PANEL_INSET}px 0 ${PANEL_INSET}px ${PANEL_INSET}px`
  }

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

  useEffect(() => {
    setGroupCollapsed((prev) => {
      const next = { ...prev }
      for (const g of groups) {
        if (next[g.id] === undefined) next[g.id] = false
      }
      return next
    })
  }, [groups])

  const activeGroup = groups.find((g) => g.projects.some((p) => p.project.path === activePath))
  const activeBranch =
    activeGroup?.projects.find((p) => p.project.path === activePath)?.branch ?? ''

  const gitFooter = showGit && onGitToggle && (
    <div
      style={{
        flex: 'none',
        padding: collapsed ? '0 0 12px' : '0 8px 12px',
        display: 'flex',
        justifyContent: 'center',
        WebkitAppRegion: 'no-drag'
      } as React.CSSProperties}
    >
      <button
        ref={gitAnchorRef}
        type="button"
        className="bf-focus bf-icon-btn"
        onClick={onGitToggle}
        title="Git status, commit, and push"
        aria-label="Git status, commit, and push"
        aria-expanded={gitOpen}
        style={{
          ...noDrag,
          width: collapsed ? 34 : '100%',
          height: 34,
          borderRadius: 8,
          border: `1px solid ${gitOpen ? C.accent : C.cardBorder}`,
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
        <GitIcon size={14} color={C.textMuted} />
        {!collapsed && (
          <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.04em' }}>Git</span>
        )}
        {gitDotColor && (
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: gitDotColor,
              flex: 'none',
              ...(collapsed
                ? { position: 'absolute', top: 6, right: 6 }
                : { marginLeft: 'auto', marginRight: 2 })
            }}
          />
        )}
      </button>
    </div>
  )

  if (showRail) {
    return (
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
          onClick={() => onSetCollapsed(false)}
          title="Show projects"
          aria-label="Show projects"
          style={{
            ...noDrag,
            width: 30,
            height: 30,
            borderRadius: 8,
            border: 0,
            background: 'transparent',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            color: '#A1A19A'
          }}
        >
          <CaretRight />
        </button>
        <div style={{ width: 22, height: 1, background: '#3E3E3A' }} />

        {activeGroup && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <ProjectIcon size={14} color={C.accentBright} />
            <RailLabel color="#F0F0EC" weight={500}>
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
            const tip = busy
              ? `${project.display} — work in progress`
              : unread
                ? `${project.display} — unread chat updates`
                : project.display
            return (
              <div
                key={project.path}
                onClick={() => {
                  onSelect(project.path)
                  onSetCollapsed(false)
                }}
                title={tip}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  cursor: 'pointer',
                  background: busy ? C.green : unread ? C.accent : C.fainter,
                  boxShadow: busy
                    ? `0 0 6px ${C.green}`
                    : unread
                      ? `0 0 6px ${C.accent}`
                      : undefined,
                  animation: busy ? 'bfpulse 1.1s ease-in-out infinite' : 'none'
                }}
              />
            )
          })}
        </div>
        {gitFooter}
      </aside>
    )
  }

  return (
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
        <span style={{ flex: 1, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.09em', color: '#A1A19A' }}>
          PROJECTS
        </span>
        <button
          type="button"
          className="bf-focus bf-icon-btn"
          onClick={() => onSetCollapsed(true)}
          title="Collapse panel"
          aria-label="Collapse projects panel"
          style={{
            ...noDrag,
            width: 26,
            height: 26,
            borderRadius: 7,
            border: 0,
            background: 'transparent',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            color: '#A1A19A'
          }}
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
                  {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={10} />}
                </button>
                <ProjectIcon size={13} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12,
                    fontWeight: 600,
                    color: C.textSoft,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
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
                  const tip = busy
                    ? `${project.display} — work in progress`
                    : unread
                      ? `${project.display} — unread chat updates`
                      : project.display
                  return (
                    <div
                      key={project.path}
                      role="button"
                      tabIndex={0}
                      className="bf-focus"
                      title={tip}
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
                        borderRadius: 7,
                        background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
                        color: active ? C.textStrong : C.textMuted,
                        cursor: 'pointer',
                        minWidth: 0
                      }}
                    >
                      <ChatActivityDot busy={busy} unread={unread} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 12.5,
                            fontWeight: active ? 600 : 500,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {branch}
                        </span>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 10.5,
                            fontFamily: UI,
                            color: C.faint,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
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
