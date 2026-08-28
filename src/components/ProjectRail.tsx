import { useEffect, useMemo, useState } from 'react'
import type { GitInfo, Project } from '@shared/types'
import { groupOpenProjects } from '@shared/project-groups'
import { C, UI } from '../theme'
import { BranchIcon, CaretLeft, CaretRight, ChevronDown, ChevronRight, ClearChatIcon, ProjectIcon } from './icons'

const api = window.buildflow

const PANEL_WIDTH = 220
const RAIL_WIDTH = 54
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

interface Props {
  projects: Project[]
  activePath: string | null
  /** Project paths with active agent or pipeline work. */
  busyPaths?: ReadonlySet<string>
  onSelect: (path: string) => void
  onClose: (path: string) => void
  /** Open the branch/worktree dialog for a project in this repo group. */
  onNewBranch: (projectPath: string) => void
  /** Select this checkout and clear its chat to start fresh. */
  onNewChat: (projectPath: string) => void
  collapsed: boolean
  onSetCollapsed: (collapsed: boolean) => void
}

/** Status dot for a checkout — pulses green while that project has work in flight. */
function ChatActivityDot({ active, busy }: { active: boolean; busy: boolean }) {
  return (
    <span
      title={busy ? 'Work in progress' : undefined}
      aria-label={busy ? 'Work in progress' : undefined}
      style={{
        width: 7,
        height: 7,
        flex: 'none',
        borderRadius: '50%',
        background: busy ? C.green : active ? C.accent : C.fainter,
        boxShadow: busy ? `0 0 6px ${C.green}` : undefined,
        animation: busy ? 'bfpulse 1.1s ease-in-out infinite' : 'none'
      }}
    />
  )
}

function shortPath(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts.slice(-2).join('/')
}

function TrafficLight({
  color,
  title,
  onClick
}: {
  color: string
  title: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="bf-focus"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        ...noDrag,
        width: 12,
        height: 12,
        borderRadius: '50%',
        border: 'none',
        padding: 0,
        background: color,
        cursor: 'pointer',
        flex: 'none'
      }}
    />
  )
}

/** Vertical label used by the collapsed rail. */
function RailLabel({
  children,
  color,
  weight
}: {
  children: React.ReactNode
  color: string
  weight?: number
}) {
  return (
    <div
      style={{
        writingMode: 'vertical-rl',
        transform: 'rotate(180deg)',
        fontSize: weight ? 11.5 : 11,
        fontWeight: weight,
        letterSpacing: weight ? '0.02em' : undefined,
        color,
        maxHeight: 220,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis'
      }}
    >
      {children}
    </div>
  )
}

export default function ProjectRail({
  projects,
  activePath,
  busyPaths,
  onSelect,
  onClose,
  onNewBranch,
  onNewChat,
  collapsed,
  onSetCollapsed
}: Props) {
  const agentBusy = (path: string): boolean => !!busyPaths?.has(path)
  const [gitByPath, setGitByPath] = useState<Record<string, GitInfo>>({})
  const [groupCollapsed, setGroupCollapsed] = useState<Record<string, boolean>>({})

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

  if (collapsed) {
    return (
      <aside
        aria-label="Projects"
        style={{
          width: RAIL_WIDTH,
          flex: 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 14,
          padding: '11px 0 14px',
          background: '#0e121a',
          borderRight: '1px solid #1a202b',
          fontFamily: UI,
          fontSize: 13,
          WebkitFontSmoothing: 'antialiased'
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            width: '100%',
            WebkitAppRegion: 'drag'
          } as React.CSSProperties}
        >
          <TrafficLight color={C.light.red} title="Close" onClick={() => api.window.close()} />
          <TrafficLight color={C.light.yellow} title="Minimise" onClick={() => api.window.minimize()} />
          <TrafficLight color={C.light.green} title="Zoom" onClick={() => api.window.maximize()} />
        </div>

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
            color: '#8b94a3'
          }}
        >
          <CaretRight />
        </button>
        <div style={{ width: 22, height: 1, background: '#212936' }} />

        {activeGroup && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <ProjectIcon size={14} color={C.accentBright} />
            <RailLabel color="#dbe1ea" weight={500}>
              {activeGroup.label}
            </RailLabel>
            {activeBranch && <RailLabel color={C.textMuted}>{activeBranch}</RailLabel>}
          </div>
        )}

        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, alignItems: 'center' }}>
          {projects.map((project) => {
            const active = project.path === activePath
            const busy = agentBusy(project.path)
            return (
              <div
                key={project.path}
                onClick={() => {
                  onSelect(project.path)
                  onSetCollapsed(false)
                }}
                title={busy ? `${project.display} — work in progress` : project.display}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  cursor: 'pointer',
                  background: busy ? C.green : active ? C.accent : C.fainter,
                  boxShadow: busy ? `0 0 6px ${C.green}` : undefined,
                  animation: busy ? 'bfpulse 1.1s ease-in-out infinite' : 'none'
                }}
              />
            )
          })}
        </div>
      </aside>
    )
  }

  return (
    <aside
      aria-label="Projects"
      style={{
        width: PANEL_WIDTH,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        background: '#0e121a',
        borderRight: '1px solid #1a202b',
        fontFamily: UI,
        fontSize: 13,
        WebkitFontSmoothing: 'antialiased'
      }}
    >
      <div
        style={{
          height: 52,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 10px 0 14px',
          WebkitAppRegion: 'drag'
        } as React.CSSProperties}
      >
        <TrafficLight color={C.light.red} title="Close" onClick={() => api.window.close()} />
        <TrafficLight color={C.light.yellow} title="Minimise" onClick={() => api.window.minimize()} />
        <TrafficLight color={C.light.green} title="Zoom" onClick={() => api.window.maximize()} />
        <span style={{ flex: 1 }} />
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
            color: '#8b94a3'
          }}
        >
          <CaretLeft />
        </button>
      </div>

      <div
        style={{
          padding: '0 12px 10px',
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: '0.09em',
          color: '#7c8595'
        }}
      >
        PROJECTS
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
                  return (
                    <div
                      key={project.path}
                      role="button"
                      tabIndex={0}
                      className="bf-focus"
                      title={busy ? `${project.display} — work in progress` : project.display}
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
                      <ChatActivityDot active={active} busy={busy} />
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
    </aside>
  )
}
