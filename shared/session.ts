/** Persisted workspace: last project, tabs, split trees, and preferences. */

import type { AppSettings } from './settings'
import type { AiProvider } from './ai'
import { normalizeAi } from './ai'

export type SavedNode =
  | { t: 'leaf'; id: string }
  | { t: 'split'; id: string; dir: 'row' | 'col'; size: number; a: SavedNode; b: SavedNode }

export interface SavedShellPane {
  id: string
  title: string
  cwd: string
  kind?: 'shell'
}

export interface SavedAgentPane {
  id: string
  title: string
  cwd: string
  kind: 'agent'
  taskId: string
  status: string
  attempt: number
  provider: AiProvider
  messages: { role: 'user' | 'assistant' | 'system'; text: string }[]
}

export type SavedPane = SavedShellPane | SavedAgentPane

export interface SavedTab {
  id: string
  title: string
  kind?: 'shell' | 'agent'
  /** Agent tabs are hidden conversations owned by one shell/worktree tab. */
  ownerTabId?: string
  branch?: string
  root: SavedNode
  focus: string
  panes: SavedPane[]
}

export interface ProjectSession {
  sidebarW: number
  selId: string | null
  activeTab: string
  tabs: SavedTab[]
}

export interface Workspace {
  lastProject: string | null
  /** All repositories restored into the window. Supersedes `lastProject`. */
  openProjects: string[]
  activeProject: string | null
  sessions: Record<string, ProjectSession>
  settings?: AppSettings
}

export function sanitizeOpenProjects(
  rawProjects: unknown,
  rawActive: unknown,
  lastProject: string | null
): { openProjects: string[]; activeProject: string | null } {
  const openProjects = Array.isArray(rawProjects)
    ? [...new Set(rawProjects.filter((projectPath): projectPath is string => typeof projectPath === 'string'))]
    : lastProject
      ? [lastProject]
      : []
  const activeProject =
    typeof rawActive === 'string' && openProjects.includes(rawActive)
      ? rawActive
      : lastProject && openProjects.includes(lastProject)
        ? lastProject
        : openProjects[0] ?? null
  return { openProjects, activeProject }
}

export function savedLeaves(n: SavedNode, out: string[] = []): string[] {
  if (n.t === 'leaf') out.push(n.id)
  else {
    savedLeaves(n.a, out)
    savedLeaves(n.b, out)
  }
  return out
}

export function sanitizeNode(raw: unknown): SavedNode | null {
  if (!raw || typeof raw !== 'object') return null
  const n = raw as Record<string, unknown>
  if (n.t === 'leaf' && typeof n.id === 'string' && n.id) return { t: 'leaf', id: n.id }
  if (n.t === 'split' && (n.dir === 'row' || n.dir === 'col') && typeof n.id === 'string') {
    const a = sanitizeNode(n.a)
    const b = sanitizeNode(n.b)
    if (!a || !b) return null
    const size = typeof n.size === 'number' && Number.isFinite(n.size) ? n.size : 50
    return { t: 'split', id: n.id, dir: n.dir, size: Math.min(85, Math.max(15, size)), a, b }
  }
  return null
}

function sanitizeAgentMessages(raw: unknown): SavedAgentPane['messages'] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((message): SavedAgentPane['messages'] => {
    if (!message || typeof message !== 'object') return []
    const item = message as Record<string, unknown>
    if (
      (item.role !== 'user' && item.role !== 'assistant' && item.role !== 'system') ||
      typeof item.text !== 'string'
    ) {
      return []
    }
    return [{ role: item.role, text: item.text }]
  })
}

function sanitizePane(raw: unknown): SavedPane | null {
  if (!raw || typeof raw !== 'object') return null
  const pane = raw as Record<string, unknown>
  if (typeof pane.id !== 'string' || typeof pane.cwd !== 'string') return null
  const base = {
    id: pane.id,
    title: typeof pane.title === 'string' ? pane.title : '',
    cwd: pane.cwd
  }
  if (pane.kind !== 'agent' || typeof pane.taskId !== 'string') return base
  const messages = Array.isArray(pane.messages) ? sanitizeAgentMessages(pane.messages) : []
  return {
    ...base,
    kind: 'agent',
    taskId: pane.taskId,
    status: typeof pane.status === 'string' ? pane.status : 'needs-attention',
    attempt: typeof pane.attempt === 'number' && Number.isFinite(pane.attempt) ? pane.attempt : 0,
    provider: normalizeAi(pane.provider),
    messages
  }
}

function sanitizeTab(raw: unknown): SavedTab | null {
  if (!raw || typeof raw !== 'object') return null
  const tab = raw as Record<string, unknown>
  const root = sanitizeNode(tab.root)
  if (typeof tab.id !== 'string' || !root) return null
  const leafIds = savedLeaves(root)
  const paneList = Array.isArray(tab.panes) ? tab.panes : []
  const byId = new Map<string, SavedPane>()
  for (const p of paneList) {
    const sp = sanitizePane(p)
    if (sp) byId.set(sp.id, sp)
  }
  const panes: SavedPane[] = []
  for (const id of leafIds) {
    const pane = byId.get(id)
    if (!pane) continue
    panes.push(pane)
  }
  if (panes.length !== leafIds.length) return null
  const focus = typeof tab.focus === 'string' && leafIds.includes(tab.focus) ? tab.focus : leafIds[0]
  return {
    id: tab.id,
    title: typeof tab.title === 'string' ? tab.title : '',
    ...(tab.kind === 'agent' ? { kind: 'agent' as const } : {}),
    ...(tab.kind === 'agent' && typeof tab.ownerTabId === 'string' && tab.ownerTabId
      ? { ownerTabId: tab.ownerTabId }
      : {}),
    ...(typeof tab.branch === 'string' && tab.branch ? { branch: tab.branch } : {}),
    root,
    focus,
    panes
  }
}

export function sanitizeSession(raw: unknown): ProjectSession | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (!Array.isArray(s.tabs)) return null
  const tabs: SavedTab[] = []
  for (const t of s.tabs) {
    const tab = sanitizeTab(t)
    if (tab) tabs.push(tab)
  }
  if (!tabs.length) return null
  const ids = new Set(tabs.map((t) => t.id))
  const activeTab =
    typeof s.activeTab === 'string' && ids.has(s.activeTab) ? s.activeTab : tabs[0].id
  const sidebarW =
    typeof s.sidebarW === 'number' && Number.isFinite(s.sidebarW)
      ? Math.min(400, Math.max(240, s.sidebarW))
      : 300
  return {
    sidebarW,
    selId: typeof s.selId === 'string' ? s.selId : null,
    activeTab,
    tabs
  }
}

export function sessionSeq(tabs: SavedTab[]): { shell: number; pane: number; split: number } {
  let shell = 0
  let pane = 0
  let split = 0
  const walk = (n: SavedNode): void => {
    if (n.t === 'leaf') {
      const m = /^p(\d+)_/.exec(n.id)
      if (m) pane = Math.max(pane, Number(m[1]))
      return
    }
    const m = /^s(\d+)$/.exec(n.id)
    if (m) split = Math.max(split, Number(m[1]))
    walk(n.a)
    walk(n.b)
  }
  for (const t of tabs) {
    const m = /^sh(\d+)$/.exec(t.id)
    if (m) shell = Math.max(shell, Number(m[1]))
    walk(t.root)
  }
  return { shell, pane, split }
}
