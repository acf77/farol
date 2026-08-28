import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentTaskEvent,
  AppSettings,
  GitInfo,
  Pipeline,
  PipelineNode,
  Project,
  ProjectSession,
  RunEvent,
  RunOrigin,
  StepState,
  WorktreeRequest
} from '@shared/types'
import { aiFixPrompt } from '@shared/ai'
import { defaultSettings } from '@shared/settings'
import { sessionSeq } from '@shared/session'
import { scopedRuntimeId, unscopedRuntimeId } from '@shared/runtime'
import { topoSort } from '@shared/graph'
import { clearIndent, emptyTerm, ensureNewline, setIndent, trimTo, write, writeLine } from './ansi'
import { agentPaneFor, chatOwnerFor, chatTabFor } from './chat-context'
import { leaf, leaves, removeLeaf, setSize, splitLeaf } from './layout'
import type { PaneNode } from './layout'
import { C, GRADIENT_BG, UI, glass as G, seg } from './theme'
import type {
  AgentMessage,
  AgentPane,
  DetailLog,
  EditorState,
  Pane,
  RunPane,
  RunState,
  RunsByBranch,
  Tab,
  View
} from './types'
import Toolbar from './components/Toolbar'
import ErrorBoundary from './ErrorBoundary'
import EmptyState from './components/EmptyState'
import NewTabDialog from './components/NewTabDialog'
import ChatPane from './components/ChatPane'
import TerminalPane from './components/TerminalPane'
import ProjectRail from './components/ProjectRail'
import Sidebar from './components/Sidebar'
import StatusBar from './components/StatusBar'
import PipelineCanvas from './components/PipelineCanvas'
import CommandPalette, { type PaletteItem } from './components/CommandPalette'
import { FolderPlusIcon } from './components/icons'

const api = window.buildflow
const MAX_LINES = 5000
const MAX_DETAIL_LOGS = 40
/**
 * Agents and pipeline runs emit events far faster than the eye reads them, and
 * each one used to re-render the whole workspace. Fold a window's worth into a
 * single pass instead — still well under a frame's worth of latency.
 */
const STREAM_FLUSH_MS = 60
/** Drop oldest run/agent events once a flush window falls this far behind. */
const MAX_STREAM_QUEUE = 400
/** Past this a single streamed turn starts a new bubble rather than growing. */
const MAX_MESSAGE_CHARS = 40_000
/** Per-message ceiling on what a restored session carries back. */
const MAX_SAVED_CHARS = 4_000
/** Hard cap on transcript length so a long agent run cannot exhaust the renderer. */
const MAX_AGENT_MESSAGES = 400
const NO_GIT: GitInfo = { isRepo: false, branch: '', branches: [] }

function asText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

function trimAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length <= MAX_AGENT_MESSAGES) return messages
  return messages.slice(-MAX_AGENT_MESSAGES)
}

function sanitizeAgentMessage(message: AgentMessage): AgentMessage {
  return {
    ...message,
    text: asText(message.text),
    ...(message.tool
      ? {
          tool: {
            ...message.tool,
            name: asText(message.tool.name),
            ...(message.tool.detail ? { detail: asText(message.tool.detail) } : {})
          }
        }
      : {}),
    ...(message.pipeline
      ? {
          pipeline: {
            ...message.pipeline,
            pipelineName: asText(message.pipeline.pipelineName),
            tabId: asText(message.pipeline.tabId)
          }
        }
      : {})
  }
}

/** Managed Chat and MCP runs share agent semantics — not manual UI runs. */
function isAgentRun(origin: RunOrigin): boolean {
  return origin === 'agent' || origin === 'managed-agent'
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, '0')}s`
}

/** Prefix streamed run lines so interleaved parallel output stays readable. */
function nodeLogPrefix(name: string): string {
  const label = name.trim() || 'step'
  return `${label.length > 18 ? `${label.slice(0, 17)}…` : label} │ `
}

function fmtTime(epoch: number): string {
  return new Date(epoch).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

const RUNTIME_PIPELINE_PREFIXES = ['pipeline:', 'managed-pipeline:', 'mcp-pipeline:'] as const

/** Unscope a runtime pipeline id back to the bare pipeline id stored in the editor. */
function unscopeLocalPipelineId(projectPath: string, runtimeId: string): string | null {
  const value = unscopedRuntimeId(projectPath, runtimeId)
  if (!value) return null
  for (const prefix of RUNTIME_PIPELINE_PREFIXES) {
    if (value.startsWith(prefix)) return value.slice(prefix.length)
  }
  return null
}

/**
 * Fallback when managed Chat reports a terminal pipeline state but the RunEvent
 * stream never bound the slot (e.g. the runner threw before `start`). The live
 * run path is owned exclusively by RunEvent handlers.
 */
function syncAgentPipelineRun(
  prev: RunsByBranch,
  event: Extract<AgentTaskEvent, { kind: 'pipeline' }>,
  pipelineId: string,
  branch: string,
  nodes: PipelineNode[]
): RunsByBranch {
  // Live runs are owned by the RunEvent stream — agent cards only mirror them.
  if (event.status === 'running') return prev
  const cur = prev[pipelineId]?.[branch]
  if (cur && event.runId && cur.runId === event.runId && cur.status !== 'running') return prev
  if (
    cur?.status === 'running' &&
    cur.runId &&
    !cur.runId.startsWith('agent:') &&
    !cur.runId.startsWith('pending:')
  ) {
    return prev
  }
  const stepResults = Object.fromEntries(nodes.map((n) => [n.id, 'pending' as StepState]))
  const time = fmtTime(event.startedAt)
  const status = event.status === 'passed' ? 'pass' : 'fail'
  const label =
    event.status === 'passed'
      ? `Passed on ${branch} · ${time}`
      : event.status === 'cancelled'
        ? `Cancelled on ${branch} · ${time}`
        : `Failed on ${branch} · ${time}`
  const finishedSteps = cur?.stepResults ?? stepResults
  return {
    ...prev,
    [pipelineId]: {
      ...prev[pipelineId],
      [branch]: {
        runId: event.runId ?? cur?.runId ?? `agent:${event.startedAt}`,
        status,
        label,
        startedAt: event.startedAt,
        stepResults: finishedSteps
      }
    }
  }
}

function fmtEventTime(epoch: number): string {
  return new Date(epoch).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

/** `HH:MM:SS`, the stamp the pipelines rail puts beside each log line. */
function clockStamp(): string {
  const d = new Date()
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

function shellPane(id: string, cwd: string): Pane {
  // No buffer, no input state: xterm.js and the PTY own everything a shell
  // pane does. BuildFlow only tracks where it is, for the title bar.
  return { id, kind: 'shell', title: api.shellName, cwd }
}

function tabsFromSession(sess: ProjectSession): Tab[] {
  const tabs = sess.tabs.map((t) => ({
    id: t.id,
    kind: t.kind === 'agent' ? ('agent' as const) : ('shell' as const),
    title: t.title || api.shellName,
    status: null,
    ownerTabId: t.ownerTabId,
    branch: t.branch,
    root: t.root as PaneNode,
    focus: t.focus,
    panes: Object.fromEntries(
      t.panes.map((p) => [
        p.id,
        p.kind === 'agent'
          ? {
              id: p.id,
              kind: 'agent' as const,
              title: p.title || 'Chat',
              cwd: p.cwd,
              taskId: p.taskId,
              status: (p.status === 'idle'
                ? 'idle'
                : p.status === 'completed' || p.status === 'cancelled'
                  ? p.status
                  : 'needs-attention') as AgentPane['status'],
              attempt: p.attempt,
              provider: p.provider,
              messages: trimAgentMessages(
                [
                  ...p.messages.map(sanitizeAgentMessage),
                  ...(p.status === 'idle' || p.status === 'completed' || p.status === 'cancelled'
                    ? []
                    : [
                        {
                          role: 'system' as const,
                          text: 'BuildFlow restarted. This managed process stopped; start a new chat to continue.'
                        }
                      ])
                ].map(sanitizeAgentMessage)
              )
            }
          : { id: p.id, kind: 'shell' as const, title: p.title || api.shellName, cwd: p.cwd }
      ])
    )
  }))
  const shellIds = new Set(tabs.filter((tab) => tab.kind === 'shell').map((tab) => tab.id))
  const fallback =
    (shellIds.has(sess.activeTab) ? sess.activeTab : undefined) ??
    tabs.find((tab) => tab.kind === 'shell')?.id
  return tabs.map((tab) =>
    tab.kind === 'agent' && (!tab.ownerTabId || !shellIds.has(tab.ownerTabId))
      ? { ...tab, ownerTabId: fallback }
      : tab
  )
}

function scopeSessionPanes(sess: ProjectSession, projectPath: string): ProjectSession {
  const paneIds = new Map<string, string>()
  for (const tab of sess.tabs) {
    for (const pane of tab.panes) paneIds.set(pane.id, scopedRuntimeId(projectPath, pane.id))
  }
  const scopeNode = (node: ProjectSession['tabs'][number]['root']): typeof node =>
    node.t === 'leaf'
      ? { ...node, id: paneIds.get(node.id) ?? scopedRuntimeId(projectPath, node.id) }
      : { ...node, a: scopeNode(node.a), b: scopeNode(node.b) }
  return {
    ...sess,
    tabs: sess.tabs.map((tab) => ({
      ...tab,
      root: scopeNode(tab.root),
      focus: paneIds.get(tab.focus) ?? scopedRuntimeId(projectPath, tab.focus),
      panes: tab.panes.map((pane) => ({
        ...pane,
        id: paneIds.get(pane.id) ?? scopedRuntimeId(projectPath, pane.id),
        ...(pane.kind === 'agent'
          ? { taskId: scopedRuntimeId(projectPath, pane.taskId) }
          : {})
      }))
    }))
  }
}

function toSession(
  tabs: Tab[],
  activeTab: string,
  sidebarW: number,
  selId: string | null
): ProjectSession {
  const savedTabs = tabs.filter((t) => t.kind === 'shell' || t.kind === 'agent')
  return {
    sidebarW,
    selId,
    activeTab: savedTabs.some((t) => t.id === activeTab) ? activeTab : (savedTabs[0]?.id ?? ''),
    tabs: savedTabs.map((t) => ({
      id: t.id,
      title: t.title,
      ...(t.kind === 'agent' ? { kind: 'agent' as const } : {}),
      ...(t.kind === 'agent' && t.ownerTabId ? { ownerTabId: t.ownerTabId } : {}),
      ...(t.branch ? { branch: t.branch } : {}),
      root: t.root,
      focus: t.focus,
      panes: Object.values(t.panes)
        .filter((p) => p.kind === 'shell' || p.kind === 'agent')
        .map((p) =>
          p.kind === 'agent'
            ? {
                id: p.id,
                title: p.title,
                cwd: p.cwd,
                kind: 'agent' as const,
                taskId: p.taskId,
                status: p.status,
                attempt: p.attempt,
                provider: p.provider,
                // A restored transcript is for reading, not for replaying a
                // whole run's output — the workspace file is rewritten often.
                messages: p.messages.map((m) => ({
                  role: m.role,
                  text: m.text.length > MAX_SAVED_CHARS ? m.text.slice(-MAX_SAVED_CHARS) : m.text
                }))
              }
            : { id: p.id, title: p.title, cwd: p.cwd }
        )
    }))
  }
}

function blankNode(): PipelineNode {
  return { id: 'n1', name: '', type: 'shell', cmd: '', after: [], gate: true, x: 72, y: 48 }
}

function disposeShells(tabList: Tab[]): void {
  tabList.forEach((t) =>
    leaves(t.root).forEach((id) => {
      if (t.panes[id]?.kind === 'shell') void api.shell.dispose(id)
    })
  )
}

function cancelAgents(tabList: Tab[]): void {
  for (const tab of tabList) {
    for (const pane of Object.values(tab.panes)) {
      if (pane.kind === 'agent') void api.agent.dispose(pane.taskId)
    }
  }
}

function normPath(p: string): string {
  return p.replace(/[/\\]+$/, '')
}

/**
 * Absolute path shown the way the spec shows it — home-relative. The home
 * prefix is recovered by subtracting the project's display path from its real
 * one, which only holds when the project is itself under home.
 */
function displayPath(p: string, project: Project | null): string {
  if (!p) return ''
  if (!project) return p
  if (normPath(p) === normPath(project.path)) return project.display
  if (!project.display.startsWith('~')) return p
  const rel = project.display.replace(/^~[/\\]?/, '')
  const home = rel ? project.path.slice(0, project.path.length - rel.length) : project.path
  return home && p.startsWith(home) ? `~/${p.slice(home.length).replace(/^[/\\]+/, '')}` : p
}

/**
 * Branch the active tab is working on. Prefer the tab's pinned branch, then
 * the worktree that owns the focused pane's cwd, then the main checkout.
 */
function branchForTab(tab: Tab | undefined, projectPath: string, git: GitInfo): string {
  if (tab?.branch) return tab.branch
  const cwd = tab?.panes[tab.focus]?.cwd ?? projectPath
  const n = normPath(cwd)
  let best: { path: string; branch: string } | undefined
  for (const w of git.worktrees ?? []) {
    if (!w.branch) continue
    const wp = normPath(w.path)
    if (n === wp || n.startsWith(wp + '/') || n.startsWith(wp + '\\')) {
      if (!best || wp.length > normPath(best.path).length) best = w
    }
  }
  if (best) return best.branch
  return git.branch || '—'
}

interface ProjectWorkspaceProps {
  project: Project
  visible: boolean
  /** Incremented when the rail asks this project to open the branch dialog. */
  branchDialogNonce: number
  /** Incremented when the rail asks this project to clear its chat. */
  newChatNonce: number
  onOpenProject: () => void
  onOpenPath: (path: string) => void
  onCloseProject: () => void
  /** Tell the project rail when this checkout's agent is working. */
  onAgentBusyChange?: (projectPath: string, busy: boolean) => void
}

function ProjectWorkspace({
  project,
  visible,
  branchDialogNonce,
  newChatNonce,
  onOpenProject,
  onOpenPath,
  onCloseProject,
  onAgentBusyChange
}: ProjectWorkspaceProps) {
  const [recents, setRecents] = useState<Project[]>([])
  const [menuOpen, setMenuOpen] = useState(false)

  const [git, setGit] = useState<GitInfo>(NO_GIT)

  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTab, setActiveTab] = useState<string>('')
  const [newTabOpen, setNewTabOpen] = useState(false)
  const [newTabError, setNewTabError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  /** Which surfaces are on screen — the spec's Chat / Terminal / Split. */
  const [view, setView] = useState<View>('chat')

  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [runs, setRuns] = useState<RunsByBranch>({})
  const [detailLogs, setDetailLogs] = useState<DetailLog[]>([])
  const [selId, setSelId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [liquid, setLiquid] = useState(false)
  const [pipesCollapsed, setPipesCollapsed] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [clearChatConfirm, setClearChatConfirm] = useState(false)
  const [chatClearedNotice, setChatClearedNotice] = useState(false)

  const seq = useRef({ shell: 1, pane: 0, split: 0 })
  const pipelinesRef = useRef<Pipeline[]>([])
  const settingsRef = useRef<AppSettings>(settings)
  const sendToAgentRef = useRef<(branch: string, cwd: string) => void>(() => {})
  const worktreeBusy = useRef(false)
  const lastRunOut = useRef<{ paneId: string; nodeId: string } | null>(null)
  /**
   * Per-pipeline generation: Stop / newer Start of the *same* pipeline bumps it so an
   * in-flight cancel→start cannot resurrect that run. Other pipelines keep their own
   * counter so concurrent Starts do not strand each other as permanently `running`.
   */
  const runStartGen = useRef<Record<string, number>>({})
  const tabsRef = useRef<Tab[]>([])
  const gitRef = useRef<GitInfo>(NO_GIT)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const snapRef = useRef({
    project: null as Project | null,
    tabs: [] as Tab[],
    activeTab: '',
    selId: null as string | null
  })
  const persistEnabled = useRef(false)
  pipelinesRef.current = pipelines
  settingsRef.current = settings
  tabsRef.current = tabs
  gitRef.current = git
  snapRef.current = { project, tabs, activeTab, selId }
  const runtimePipelineId = (pipelineId: string): string =>
    scopedRuntimeId(project.path, `pipeline:${pipelineId}`)
  /** Managed Chat validation must not share the UI Run slot for the same pipeline. */
  const managedRuntimePipelineId = (pipelineId: string): string =>
    scopedRuntimeId(project.path, `managed-pipeline:${pipelineId}`)
  const localPipelineId = (runtimeId: string): string | null =>
    unscopeLocalPipelineId(project.path, runtimeId)

  const flushSession = (last: boolean): void => {
    if (last && !persistEnabled.current) return
    const s = snapRef.current
    if (!s.project || !s.tabs.some((t) => t.kind === 'shell' || t.kind === 'agent')) {
      if (!last) void api.session.clearLast()
      return
    }
    void api.session.save(s.project.path, toSession(s.tabs, s.activeTab, 300, s.selId), last)
  }

  const nextPaneId = (): string =>
    scopedRuntimeId(project.path, `p${++seq.current.pane}_${Date.now().toString(36).slice(-3)}`)

  const pushLog = useCallback((text: string, color: string) => {
    setDetailLogs((prev) => [...prev, { t: clockStamp(), text, color }].slice(-MAX_DETAIL_LOGS))
  }, [])

  /* --------------------------------------------------------------- panes */

  /** Panes are addressed by id alone — ids are unique across every tab. */
  const patchPane = useCallback((paneId: string, fn: (p: Pane) => Pane) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.panes[paneId] ? { ...t, panes: { ...t.panes, [paneId]: fn(t.panes[paneId]) } } : t
      )
    )
  }, [])

  const patchTab = useCallback((tabId: string, fn: (t: Tab) => Tab) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? fn(t) : t)))
  }, [])

  /** Terminal tabs stay visible; agent tabs persist one hidden chat per shell/worktree. */
  const termTabs = useMemo(() => tabs.filter((t) => t.kind !== 'agent'), [tabs])
  const active = useMemo(
    () => termTabs.find((t) => t.id === activeTab) ?? termTabs[0],
    [termTabs, activeTab]
  )
  const chatOwner = useMemo(() => chatOwnerFor(termTabs, active?.id ?? activeTab), [termTabs, active, activeTab])
  const chatTab = useMemo(() => chatTabFor(tabs, chatOwner?.id), [tabs, chatOwner])
  const chatPane = useMemo(() => agentPaneFor(chatTab), [chatTab])

  const agentBusy = useMemo(() => {
    const live = new Set(['working', 'validating', 'repairing'])
    return tabs.some((tab) =>
      Object.values(tab.panes).some((pane) => pane.kind === 'agent' && live.has(pane.status))
    )
  }, [tabs])

  const runBranchForBusy = project ? branchForTab(active, project.path, git) : git.branch || '—'
  const pipelineBusy = useMemo(() => {
    for (const byBranch of Object.values(runs)) {
      if (byBranch[runBranchForBusy]?.status === 'running') return true
    }
    return false
  }, [runs, runBranchForBusy])

  const worktreeBusyFlag = agentBusy || pipelineBusy

  useEffect(() => {
    onAgentBusyChange?.(project.path, worktreeBusyFlag)
    return () => onAgentBusyChange?.(project.path, false)
  }, [worktreeBusyFlag, onAgentBusyChange, project.path])

  const loadGit = useCallback(async (projectPath: string) => {
    setGit(await api.git.info(projectPath))
  }, [])

  /** Bring the terminal on screen — split keeps chat visible; terminal is logs-only. */
  const showTerminal = useCallback((tabId?: string, mode: 'split' | 'terminal' = 'split') => {
    if (tabId) setActiveTab(tabId)
    if (mode === 'terminal') setView('terminal')
    else setView((v) => (v === 'chat' ? 'split' : v))
  }, [])

  /** Returns the pane that will take input, so callers can write into it. */
  const openShellTab = useCallback(
    (cwd: string, branch?: string): string | null => {
      if (!project) return null
      if (branch) {
        const existing = tabsRef.current.find((t) => t.kind === 'shell' && t.branch === branch)
        if (existing) {
          setActiveTab(existing.id)
          showTerminal(existing.id)
          return existing.focus
        }
      }
      const id = `sh${++seq.current.shell}`
      const paneId = nextPaneId()
      setTabs((prev) => [
        ...prev,
        {
          id,
          kind: 'shell',
          title: branch || api.shellName,
          status: null,
          branch,
          root: leaf(paneId),
          focus: paneId,
          panes: { [paneId]: shellPane(paneId, cwd) }
        }
      ])
      setActiveTab(id)
      showTerminal(id)
      return paneId
    },
    [project, showTerminal]
  )

  /** Make a worktree's independent chat on demand. Pass an owner when the active tab is a run. */
  const ensureChat = useCallback(
    (owner: Tab | undefined = chatOwner): { pane: AgentPane; owner: Tab } | null => {
      if (!project || !owner) return null
      const existing = chatTabFor(tabsRef.current, owner.id)
      const existingPane = agentPaneFor(existing)
      if (existingPane) return { pane: existingPane, owner }

      const cwd = owner.panes[owner.focus]?.cwd || project.path
      const taskId = scopedRuntimeId(project.path, `agent:${owner.id}:${Date.now()}`)
      const paneId = `ap:${taskId}`
      const pane: AgentPane = {
        id: paneId,
        kind: 'agent',
        title: 'Chat',
        cwd,
        taskId,
        status: 'idle',
        attempt: 0,
        provider: settingsRef.current.agent,
        messages: []
      }
      setTabs((prev) => [
        ...prev,
        {
          id: taskId,
          kind: 'agent',
          title: 'Chat',
          status: null,
          ownerTabId: owner.id,
          branch: branchForTab(owner, project.path, gitRef.current),
          root: leaf(paneId),
          focus: paneId,
          panes: { [paneId]: pane }
        }
      ])
      return { pane, owner }
    },
    [project, chatOwner]
  )

  /** Discard the active worktree's conversation. Other agents continue. */
  const clearChat = useCallback((hadMessages = false) => {
    if (!chatOwner) return
    const existing = chatTabFor(tabsRef.current, chatOwner.id)
    if (existing) {
      const pane = existing.panes[existing.focus]
      if (pane && pane.kind === 'agent') void api.agent.dispose(pane.taskId)
      setTabs((prev) => prev.filter((t) => t.id !== existing.id))
    }
    setClearChatConfirm(false)
    if (hadMessages) setChatClearedNotice(true)
    setView((v) => (v === 'terminal' ? 'split' : v))
  }, [chatOwner])

  /** One chat per branch — this clears it and shows a blank composer, not a second tab. */
  const requestNewChat = useCallback(() => {
    if (!chatOwner) return
    const existing = chatTabFor(tabsRef.current, chatOwner.id)
    const hasMessages = (agentPaneFor(existing)?.messages.length ?? 0) > 0
    if (hasMessages) {
      setChatClearedNotice(false)
      setClearChatConfirm(true)
      setView('chat')
      return
    }
    clearChat(false)
  }, [chatOwner, clearChat])

  /** Tabs share this project's checkout — no worktree, no branch switch. */
  const newShellTab = useCallback(() => {
    if (!project) return
    openShellTab(project.path)
  }, [project, openShellTab])

  /** Parallel branch work opens as its own project (separate worktree). */
  const openBranchDialog = useCallback(async () => {
    if (!project) return
    // Refresh at the moment the picker opens. Git state may still be loading
    // after a project switch, and worktrees can be added outside BuildFlow.
    const fresh = await api.git.info(project.path)
    setGit(fresh)
    if (!fresh.isRepo) return
    setNewTabError(null)
    setNewTabOpen(true)
  }, [project])

  const branchDialogSeen = useRef(0)
  useEffect(() => {
    if (!visible || !branchDialogNonce || branchDialogNonce === branchDialogSeen.current) return
    branchDialogSeen.current = branchDialogNonce
    void openBranchDialog()
  }, [visible, branchDialogNonce, openBranchDialog])

  const newChatSeen = useRef(0)
  useEffect(() => {
    if (!visible || !newChatNonce || newChatNonce === newChatSeen.current) return
    newChatSeen.current = newChatNonce
    requestNewChat()
    setView('chat')
  }, [visible, newChatNonce, requestNewChat])

  const openWorktreeProject = useCallback(
    async (req: WorktreeRequest): Promise<{ ok: boolean; message: string }> => {
      if (!project || worktreeBusy.current) return { ok: false, message: '' }
      worktreeBusy.current = true
      setCreating(true)
      try {
        const res = await api.git.worktree(project.path, req)
        if (!res.ok || !res.path) {
          return { ok: false, message: res.message || 'could not open worktree' }
        }
        const same = normPath(res.path) === normPath(project.path)
        // Same checkout: stay put. Otherwise open/focus that worktree as a project.
        if (!same) onOpenPath(res.path)
        void loadGit(project.path)
        return { ok: true, message: '' }
      } finally {
        worktreeBusy.current = false
        setCreating(false)
      }
    },
    [project, onOpenPath, loadGit]
  )

  const createBranchProject = useCallback(
    async (req: WorktreeRequest) => {
      const res = await openWorktreeProject(req)
      if (!res.ok) {
        setNewTabError(res.message)
        return
      }
      setNewTabError(null)
      setNewTabOpen(false)
    },
    [openWorktreeProject]
  )

  const openExistingWorktree = useCallback(
    (branch: string) => {
      if (!project) return
      const tree = gitRef.current.worktrees?.find((worktree) => worktree.branch === branch)
      if (!tree) {
        setNewTabError(`Worktree for ${branch} is no longer available`)
        setNewTabOpen(true)
        void loadGit(project.path)
        return
      }

      if (normPath(tree.path) !== normPath(project.path)) onOpenPath(tree.path)
      setNewTabError(null)
      setNewTabOpen(false)
    },
    [project, loadGit, onOpenPath]
  )

  const closeTab = useCallback(
    (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id)
      if (!tab) return
      if (tab.kind === 'shell' && tabsRef.current.filter((t) => t.kind === 'shell').length <= 1) return
      if (tab.kind === 'agent') {
        const pane = agentPaneFor(tab)
        if (pane) void api.agent.dispose(pane.taskId)
      }
      const linkedAgents = tabsRef.current.filter((t) => t.kind === 'agent' && t.ownerTabId === id)
      for (const linked of linkedAgents) {
        const pane = agentPaneFor(linked)
        if (pane) void api.agent.dispose(pane.taskId)
      }
      // Closing a run tab stops watching it; the run itself keeps going.
      leaves(tab.root).forEach((paneId) => {
        if (tab.panes[paneId]?.kind === 'shell') void api.shell.dispose(paneId)
      })
      const list = tabsRef.current.filter((t) => t.kind !== 'agent')
      const idx = list.findIndex((t) => t.id === id)
      const rest = list.filter((t) => t.id !== id)
      setTabs((prev) => prev.filter((t) => t.id !== id && t.ownerTabId !== id))
      if (activeTab === id) setActiveTab(rest[Math.max(0, idx - 1)]?.id ?? '')
    },
    [activeTab]
  )

  /** Split the focused shell pane; new pane starts in the same directory. */
  const splitPane = useCallback(
    (dir: 'row' | 'col') => {
      const tab = tabsRef.current.find((t) => t.id === activeTab)
      if (!tab || tab.kind !== 'shell') return
      const focus = tab.panes[tab.focus]
      if (!focus || focus.kind !== 'shell') return
      const paneId = nextPaneId()
      const splitId = `s${++seq.current.split}`
      patchTab(tab.id, (t) => ({
        ...t,
        root: splitLeaf(t.root, t.focus, dir, paneId, splitId),
        focus: paneId,
        panes: { ...t.panes, [paneId]: shellPane(paneId, focus.cwd) }
      }))
      setView((v) => (v === 'chat' ? 'split' : v))
    },
    [activeTab, patchTab]
  )

  const closePane = useCallback(
    (tabId: string, paneId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId)
      if (!tab) return
      const nextRoot = removeLeaf(tab.root, paneId)
      if (!nextRoot) {
        closeTab(tabId)
        return
      }
      if (tab.panes[paneId]?.kind === 'shell') void api.shell.dispose(paneId)
      const remaining = leaves(nextRoot)
      patchTab(tabId, (t) => {
        const panes = { ...t.panes }
        delete panes[paneId]
        return {
          ...t,
          root: nextRoot,
          focus: remaining.includes(t.focus) ? t.focus : remaining[remaining.length - 1]!,
          panes
        }
      })
    },
    [closeTab, patchTab]
  )

  /* ------------------------------------------------------------- project */

  const loadProject = useCallback(
    async () => {
      persistEnabled.current = false
      setMenuOpen(false)
      setNewTabOpen(false)
      setEditor(null)
      setRuns({})
      setDetailLogs([])

      const rawSession = await api.session.load(project.path)
      const sess = rawSession ? scopeSessionPanes(rawSession, project.path) : null
      if (sess) {
        const restored = tabsFromSession(sess)
        seq.current = sessionSeq(rawSession?.tabs ?? [])
        setTabs(restored)
        const firstTerm = restored.find((t) => t.kind !== 'agent')
        setActiveTab(
          restored.some((t) => t.id === sess.activeTab && t.kind !== 'agent')
            ? sess.activeTab
            : (firstTerm?.id ?? '')
        )
      } else {
        seq.current = { shell: 1, pane: 0, split: 0 }
        const paneId = nextPaneId()
        setTabs([
          {
            id: 'sh1',
            kind: 'shell',
            title: api.shellName,
            status: null,
            root: leaf(paneId),
            focus: paneId,
            panes: { [paneId]: shellPane(paneId, project.path) }
          }
        ])
        setActiveTab('sh1')
      }

      void loadGit(project.path)
      const loaded = await api.pipelines.load(project.path)
      setPipelines(loaded)
      const keep =
        sess?.selId && loaded.some((x) => x.id === sess.selId) ? sess.selId : (loaded[0]?.id ?? null)
      setSelId(keep)
      persistEnabled.current = true
    },
    [project.path, loadGit]
  )

  useEffect(() => {
    void api.ui.glass().then(setLiquid)
    return api.ui.onGlass(setLiquid)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('bf-glass', liquid)
  }, [liquid])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setRecents(await api.project.recents())
      setSettings(await api.settings.load())
      if (cancelled) return
      await loadProject()
      persistEnabled.current = true
    })()
    return () => {
      cancelled = true
    }
  }, [loadProject])

  useEffect(() => {
    if (visible) void api.settings.load().then(setSettings)
  }, [visible])

  useEffect(() => {
    if (!persistEnabled.current || !project) return
    const t = window.setTimeout(() => flushSession(true), 400)
    return () => window.clearTimeout(t)
  }, [project, tabs, activeTab, selId])

  useEffect(() => {
    const onGone = (): void => {
      if (persistEnabled.current && snapRef.current.project) flushSession(true)
    }
    window.addEventListener('beforeunload', onGone)
    window.addEventListener('pagehide', onGone)
    return () => {
      onGone()
      window.removeEventListener('beforeunload', onGone)
      window.removeEventListener('pagehide', onGone)
      cancelAgents(tabsRef.current)
      disposeShells(tabsRef.current)
    }
  }, [])

  // HEAD can move from a shell pane or another app; follow it either way.
  useEffect(
    () =>
      api.git.onChanged((changed) => {
        if (normPath(changed.projectPath) === normPath(project.path)) setGit(changed.info)
      }),
    [project.path]
  )

  useEffect(
    () => api.update.onStatus((s) => setUpdateVersion(s.state === 'ready' ? s.version : null)),
    []
  )

  const persist = useCallback(
    (next: Pipeline[]) => {
      setPipelines(next)
      if (project) void api.pipelines.save(project.path, next)
    },
    [project]
  )

  /* --------------------------------------------------------- shell wiring */

  // xterm panes stream their own data; the app only follows `cd` for titles.
  useEffect(
    () =>
      api.shell.onCwd(({ paneId, cwd }) =>
        patchPane(paneId, (p) => (p.kind === 'shell' ? { ...p, cwd } : p))
      ),
    [patchPane]
  )

  const applyAgentEvent = useCallback((pane: AgentPane, event: AgentTaskEvent): AgentPane => {
    const appendMessages = (messages: AgentMessage[]): AgentPane => ({
      ...pane,
      messages: trimAgentMessages(messages.map(sanitizeAgentMessage))
    })
    if (event.kind === 'output') {
      const chunk = asText(event.chunk)
      const messages = [...pane.messages]
      const last = messages[messages.length - 1]
      // Only plain prose keeps growing; a card or an oversized turn is closed.
      if (
        last?.role === 'assistant' &&
        !last.tool &&
        !last.pipeline &&
        asText(last.text).length < MAX_MESSAGE_CHARS
      )
        messages[messages.length - 1] = { ...last, text: asText(last.text) + chunk }
      else messages.push({ role: 'assistant', text: chunk })
      return appendMessages(messages)
    }
    if (event.kind === 'assistant') {
      return appendMessages([...pane.messages, { role: 'assistant', text: asText(event.text) }])
    }
    if (event.kind === 'tool') {
      const messages = [...pane.messages]
      let existing = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].tool?.toolId === event.toolId) {
          existing = i
          break
        }
      }
      // The finishing event names the tool but repeats none of its input,
      // so the card it closes keeps the detail it was opened with.
      const card = existing >= 0 ? messages[existing].tool! : { toolId: event.toolId, name: event.name }
      const tool = {
        ...card,
        name: event.name || card.name,
        ...(event.detail ? { detail: event.detail } : {}),
        state: event.state
      }
      const message = {
        role: 'system' as const,
        text: `${tool.name}${tool.detail ? ` — ${tool.detail}` : ''}`,
        tool
      }
      if (existing >= 0) messages[existing] = message
      else messages.push(message)
      return appendMessages(messages)
    }
    if (event.kind === 'user') {
      return appendMessages([...pane.messages, { role: 'user', text: asText(event.text), at: Date.now() }])
    }
    if (event.kind === 'pipeline') {
      const text =
        event.status === 'running'
          ? `$ pipeline run — started ${fmtEventTime(event.startedAt)}`
          : `${event.status} — ${fmtEventTime(event.finishedAt ?? event.startedAt)}${event.durationMs === undefined ? '' : ` · ${fmtDuration(event.durationMs)}`}`
      // The tab a pipeline run streams to is addressed the same way
      // runPipeline() addresses one it started directly — by pipeline
      // and the branch the owning tab is on.
      const owner = tabsRef.current.find((t) =>
        Object.values(t.panes).some((p) => p.kind === 'agent' && p.taskId === event.taskId)
      )
      const proj = snapRef.current.project
      const branch = owner && proj ? branchForTab(owner, proj.path, gitRef.current) : ''
      const message = {
        role: 'system' as const,
        text,
        pipeline: {
          pipelineId: localPipelineId(event.pipelineId) ?? event.pipelineId,
          pipelineName: event.pipelineName,
          status: event.status,
          startedAt: event.startedAt,
          finishedAt: event.finishedAt,
          durationMs: event.durationMs,
          tabId: `run:${localPipelineId(event.pipelineId) ?? event.pipelineId}:${branch}`
        }
      }
      const messages = [...pane.messages]
      let existing = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        const card = messages[i].pipeline
        if (
          card?.pipelineId === (localPipelineId(event.pipelineId) ?? event.pipelineId) &&
          card.startedAt === event.startedAt
        ) {
          existing = i
          break
        }
      }
      if (existing >= 0) messages[existing] = message
      else messages.push(message)
      return appendMessages(messages)
    }
    const announce = event.status !== 'validating' && event.status !== 'completed'
    const message = asText(event.message)
    return {
      ...pane,
      status: event.status,
      attempt: event.attempt,
      messages: announce ? trimAgentMessages([...pane.messages, { role: 'system', text: message }]) : pane.messages
    }
  }, [])

  /** Agent panes are keyed `ap:${taskId}`; scan when ids drift after restore. */
  const agentPaneByTaskId = useCallback(
    (panes: Record<string, Pane>, taskId: string): AgentPane | null => {
      const direct = panes[`ap:${taskId}`]
      if (direct?.kind === 'agent') return direct
      for (const pane of Object.values(panes)) {
        if (pane.kind === 'agent' && pane.taskId === taskId) return pane
      }
      return null
    },
    []
  )

  /**
   * An agent at work emits events far faster than a person reads them, and one
   * state update each re-rendered the entire workspace — which is what used to
   * lock the window up mid-run. Queue them and fold each window into one pass.
   */
  const agentQueue = useRef<AgentTaskEvent[]>([])
  const agentFlush = useRef<number | null>(null)

  useEffect(() => {
    const flush = (): void => {
      agentFlush.current = null
      const queued = agentQueue.current
      if (!queued.length) return
      agentQueue.current = []
      try {
        const pipelineEvents = queued.filter(
          (event): event is Extract<AgentTaskEvent, { kind: 'pipeline' }> => event.kind === 'pipeline'
        )
        if (pipelineEvents.length) {
          const proj = snapRef.current.project
          setRuns((prev) => {
            let next = prev
            for (const event of pipelineEvents) {
              const pipelineId = proj ? unscopeLocalPipelineId(proj.path, event.pipelineId) : null
              if (!pipelineId) continue
              const p = pipelinesRef.current.find((x) => x.id === pipelineId)
              if (!p) continue
              const owner = tabsRef.current.find((t) =>
                Object.values(t.panes).some((pane) => pane.kind === 'agent' && pane.taskId === event.taskId)
              )
              const branch = owner && proj ? branchForTab(owner, proj.path, gitRef.current) : ''
              if (!branch) continue
              next = syncAgentPipelineRun(next, event, pipelineId, branch, p.nodes)
            }
            return next === prev ? prev : next
          })
        }
        setTabs((prev) => {
          let touched = false
          const next = prev.map((tab) => {
            let panes = tab.panes
            for (const event of queued) {
              const pane = agentPaneByTaskId(panes, event.taskId)
              if (!pane) continue
              const updated = applyAgentEvent(pane, event)
              if (updated !== pane) panes = { ...panes, [pane.id]: updated }
            }
            if (panes === tab.panes) return tab
            touched = true
            return { ...tab, panes }
          })
          return touched ? next : prev
        })
      } catch (error) {
        console.error('[buildflow] agent event flush failed', error)
      }
    }
    const off = api.agent.onEvent((event: AgentTaskEvent) => {
      const queue = agentQueue.current
      const last = queue[queue.length - 1]
      if (event.kind === 'output' && last?.kind === 'output' && last.taskId === event.taskId) {
        last.chunk += event.chunk
      } else {
        queue.push(event)
      }
      if (queue.length > MAX_STREAM_QUEUE) queue.splice(0, queue.length - MAX_STREAM_QUEUE)
      if (agentFlush.current === null) agentFlush.current = window.setTimeout(flush, STREAM_FLUSH_MS)
    })
    return () => {
      off()
      if (agentFlush.current !== null) window.clearTimeout(agentFlush.current)
      agentFlush.current = null
    }
  }, [applyAgentEvent, agentPaneByTaskId])

  const sendAgentMessage = useCallback(
    (text: string, providerOverride?: AppSettings['agent'], ownerOverride?: Tab, cwdOverride?: string) => {
      setChatClearedNotice(false)
      const context = ensureChat(ownerOverride)
      if (!context || !project) return
      const { pane, owner } = context
      const clean = text.trim()
      if (!clean) return
      const provider = providerOverride ?? pane.provider

      const availablePipelines = pipelinesRef.current
        .filter((pipeline) => pipeline.nodes.length)
        .map((pipeline) => ({ ...pipeline, id: managedRuntimePipelineId(pipeline.id) }))
      if (!availablePipelines.length) return

      const branch = branchForTab(owner, project.path, git)
      const failStart = (message?: string): void => {
        patchPane(pane.id, (current) =>
          current.kind === 'agent'
            ? {
                ...current,
                status: 'failed',
                messages: [
                  ...current.messages,
                  { role: 'system', text: message || 'Could not start agent' }
                ]
              }
            : current
        )
      }
      const startRequest = {
        id: pane.taskId,
        prompt: clean,
        provider,
        pipelines: availablePipelines,
        cwd: cwdOverride || pane.cwd,
        branch
      }
      const runAgent = (mode: 'message' | 'start'): void => {
        if (mode === 'message') {
          // Prefer start when the task is gone (e.g. after a restart).
          void api.agent.message(pane.taskId, clean, provider).then((result) => {
            if (result.ok) return
            runAgent('start')
          })
          return
        }
        void api.agent.start(startRequest).then((result) => {
          if (result.ok) return
          // Still winding down after Stop — queue with the selected provider.
          void api.agent.message(pane.taskId, clean, provider).then((queued) => {
            if (queued.ok) return
            failStart(result.message || queued.message)
          })
        })
      }

      if (pane.status === 'idle') {
        patchPane(pane.id, (current) =>
          current.kind === 'agent'
            ? {
                ...current,
                status: 'working',
                attempt: 1,
                provider,
                messages: [
                  ...current.messages,
                  {
                    role: 'system',
                    text: `Choosing from ${availablePipelines.length} validation pipeline${availablePipelines.length === 1 ? '' : 's'}.`
                  }
                ]
              }
            : current
        )
        runAgent('start')
        return
      }

      patchPane(pane.id, (current) =>
        current.kind === 'agent' ? { ...current, status: 'working', provider } : current
      )
      // Resume the same task so history and the selected provider carry forward.
      runAgent('message')
    },
    [ensureChat, project, git, patchPane]
  )

  /**
   * Hand a failed manual run to the UI chat so the user can keep talking there.
   * Agent-started runs stay out — otherwise a pipeline the chat ran and failed
   * would spawn another agent, and so on.
   */
  const sendToAgent = useCallback(
    (branch: string, cwd: string) => {
      const shells = tabsRef.current.filter((t) => t.kind === 'shell')
      const owner =
        shells.find((t) => t.panes[t.focus]?.cwd === cwd) ??
        shells.find((t) => t.branch === branch) ??
        shells[0]
      if (owner) setActiveTab(owner.id)
      else openShellTab(cwd, branch)
      setView('chat')
      sendAgentMessage(aiFixPrompt(), undefined, owner, cwd)
    },
    [openShellTab, sendAgentMessage]
  )
  sendToAgentRef.current = sendToAgent

  const setAgentProvider = useCallback(
    (provider: AppSettings['agent']) => {
      setSettings((prev) => {
        const next = { ...prev, agent: provider }
        void api.settings.save(next)
        return next
      })
      if (!chatPane) return
      // Always record the choice on the pane so the next start/message uses it,
      // including when the user switches after a usage/session limit mid-chat.
      patchPane(chatPane.id, (pane) =>
        pane.kind === 'agent' ? { ...pane, provider } : pane
      )
      void api.agent.setProvider(chatPane.taskId, provider)
    },
    [chatPane, patchPane]
  )

  const cancelAgent = useCallback(() => {
    if (chatPane) void api.agent.cancel(chatPane.taskId)
  }, [chatPane])

  /* -------------------------------------------------------------- running */

  const runPipeline = useCallback(
    async (pipelineId: string) => {
      const p = pipelinesRef.current.find((x) => x.id === pipelineId)
      if (!p || !project) return
      const paneCwd = active?.panes[active.focus]?.cwd
      const cwd = paneCwd || project.path
      let branch = branchForTab(active, project.path, git)
      if (paneCwd) {
        const info = await api.git.info(paneCwd)
        if (info.isRepo && info.branch) branch = info.branch
      }

      let blocked = false
      const pendingRunId = `pending:${Date.now()}`
      setRuns((prev) => {
        if (prev[pipelineId]?.[branch]?.status === 'running') {
          blocked = true
          return prev
        }
        return {
          ...prev,
          [pipelineId]: {
            ...prev[pipelineId],
            [branch]: {
              runId: pendingRunId,
              status: 'running',
              label: 'Starting…',
              startedAt: Date.now(),
              stepResults: Object.fromEntries(p.nodes.map((n) => [n.id, 'pending' as StepState]))
            }
          }
        }
      })
      if (blocked) return

      const tabId = `run:${pipelineId}:${branch}`
      const paneId = `rp:${pipelineId}:${branch}`
      const fresh: Tab = {
        id: tabId,
        kind: 'run',
        title: p.name,
        status: 'running',
        branch,
        root: leaf(paneId),
        focus: paneId,
        panes: { [paneId]: { id: paneId, kind: 'run', title: p.name, cwd, term: emptyTerm() } }
      }

      // Re-running resets the log buffer. Appending forever let verbose CI
      // output compound across runs until the renderer OOMed.
      setTabs((prev) =>
        prev.some((t) => t.id === tabId)
          ? prev.map((t) => {
              if (t.id !== tabId) return t
              const pane = t.panes[paneId]
              const nextPane =
                pane?.kind === 'run'
                  ? {
                      ...pane,
                      cwd,
                      term: writeLine(ensureNewline(emptyTerm()), `── rerun ${clockStamp()} ──`, {
                        color: '#8b94a3',
                        dim: true
                      })
                    }
                  : fresh.panes[paneId]
              return {
                ...t,
                status: 'running',
                title: p.name,
                branch,
                panes: { ...t.panes, [paneId]: nextPane }
              }
            })
          : [...prev, fresh]
      )
      setSelId(pipelineId)
      setEditor(null)
      setDetailLogs([{ t: clockStamp(), text: `Queued pipeline: ${p.name}`, color: '#a9b2c1' }])
      setActiveTab(tabId)
      setView('terminal')
      const runtimeId = runtimePipelineId(pipelineId)
      const gen = (runStartGen.current[pipelineId] = (runStartGen.current[pipelineId] ?? 0) + 1)
      // Wait for cancel so a stopped run cannot race start and keep the old session.
      await api.run.cancel(runtimeId)
      // Stop (or a newer Start of *this* pipeline) during the await bumps the gen — do not start.
      if (gen !== runStartGen.current[pipelineId]) {
        // Clear our optimistic slot if nothing else settled it (Stop / a later Start).
        setRuns((prev) => {
          const cur = prev[pipelineId]?.[branch]
          if (!cur || cur.runId !== pendingRunId || cur.status !== 'running') return prev
          return {
            ...prev,
            [pipelineId]: {
              ...prev[pipelineId],
              [branch]: {
                ...cur,
                runId: `cancelled:${cur.runId}`,
                status: 'fail',
                label: `Cancelled on ${branch} · ${fmtTime(cur.startedAt)}`
              }
            }
          }
        })
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId && t.status === 'running' ? { ...t, status: 'fail' } : t))
        )
        return
      }
      void api.run.start({ ...p, id: runtimeId }, cwd, branch)
    },
    [project, git, active]
  )

  useEffect(() => {
    const handle = (e: RunEvent): void => {
      const pipelineId = localPipelineId(e.pipelineId)
      if (!pipelineId) return
      const p = pipelinesRef.current.find((x) => x.id === pipelineId)
      if (!p) return
      const { branch } = e
      const tabId = `run:${pipelineId}:${branch}`
      const paneId = `rp:${pipelineId}:${branch}`
      const nodes = topoSort(p.nodes) ?? p.nodes
      const byId = new Map(nodes.map((n) => [n.id, n]))
      const total = nodes.length

      const term = (fn: (pane: RunPane) => RunPane): void =>
        patchPane(paneId, (pane) => (pane.kind === 'run' ? fn(pane) : pane))
      const patchRun = (fn: (r: RunState) => RunState): void =>
        setRuns((prev) => {
          const cur = prev[pipelineId]?.[branch]
          if (!cur) return prev
          // Ignore output from a cancelled predecessor after a newer run was queued.
          if (cur.runId !== e.runId) return prev
          return { ...prev, [pipelineId]: { ...prev[pipelineId], [branch]: fn(cur) } }
        })
      const stepAt = (nodeId: string, v: StepState): void =>
        patchRun((r) => ({ ...r, stepResults: { ...r.stepResults, [nodeId]: v } }))

      switch (e.kind) {
        case 'start': {
          lastRunOut.current = null
          // A run the user started already made its tab. One an agent asked
          // for has none, so make it here — otherwise the run is invisible.
          if (isAgentRun(e.origin)) {
            setTabs((prev) =>
              prev.some((t) => t.id === tabId)
                ? prev
                : [
                    ...prev,
                    {
                      id: tabId,
                      kind: 'run',
                      title: p.name,
                      status: 'running',
                      branch,
                      root: leaf(paneId),
                      focus: paneId,
                      panes: {
                        [paneId]: { id: paneId, kind: 'run', title: p.name, cwd: '', term: emptyTerm() }
                      }
                    }
                  ]
            )
            setSelId(pipelineId)
          }
          setRuns((prev) => {
            const cur = prev[pipelineId]?.[branch]
            if (cur) {
              if (cur.runId === e.runId) return prev
              if (
                cur.status === 'running' &&
                (cur.runId.startsWith('pending:') || cur.runId.startsWith('agent:'))
              ) {
                // Bind the optimistic slot to the real run id.
              } else if (cur.status === 'running') {
                // A newer live run already owns this slot.
                return prev
              } else if (!isAgentRun(e.origin)) {
                // Stop/finish already settled the UI — ignore a late start.
                return prev
              }
            }
            return {
              ...prev,
              [pipelineId]: {
                ...prev[pipelineId],
                [branch]: {
                  runId: e.runId,
                  status: 'running',
                  label: 'Running…',
                  startedAt: Date.now(),
                  stepResults: Object.fromEntries(nodes.map((n) => [n.id, 'pending' as StepState]))
                }
              }
            }
          })
          patchTab(tabId, (t) => ({ ...t, status: 'running' }))
          term((pane) => ({
            ...pane,
            term: writeLine(
              writeLine(
                writeLine(
                  ensureNewline(pane.term),
                  `▶ ${p.name} — ${total} step${total === 1 ? '' : 's'}`,
                  seg('head')
                ),
                `  branch ${branch} · ${new Date().toLocaleTimeString()}`,
                seg('dim')
              ),
              '',
              {}
            )
          }))
          break
        }

        case 'step-start': {
          lastRunOut.current = null
          const name = byId.get(e.nodeId)?.name || e.nodeId
          stepAt(e.nodeId, 'running')
          pushLog(`Starting step: ${name}`, '#a9b2c1')
          term((pane) => ({
            ...pane,
            term: writeLine(
              ensureNewline(clearIndent(pane.term)),
              `[${e.index + 1}/${total}] ${name}`,
              seg('step')
            )
          }))
          break
        }

        case 'output': {
          const name = byId.get(e.nodeId)?.name || e.nodeId
          const prefix = nodeLogPrefix(name)
          const switched =
            lastRunOut.current?.paneId !== paneId || lastRunOut.current?.nodeId !== e.nodeId
          lastRunOut.current = { paneId, nodeId: e.nodeId }
          term((pane) => {
            const t = switched ? setIndent(ensureNewline(clearIndent(pane.term)), prefix) : pane.term
            return { ...pane, term: trimTo(write(t, e.chunk), MAX_LINES) }
          })
          break
        }

        case 'step-end': {
          lastRunOut.current = null
          const st: StepState = e.skipped ? 'skip' : e.ok ? 'pass' : e.cancelled ? 'skip' : 'fail'
          stepAt(e.nodeId, st)
          const name = byId.get(e.nodeId)?.name || e.nodeId
          const text = e.skipped
            ? `– ${name} skipped`
            : e.ok
              ? `✓ ${name} (${fmtDuration(e.durationMs)})`
              : e.cancelled
                ? `■ ${name} cancelled`
                : `✗ ${name} (${fmtDuration(e.durationMs)}) — exit code ${e.code}`
          pushLog(text, e.ok ? '#5fd39a' : e.skipped || e.cancelled ? '#8b94a3' : '#e07b7b')
          term((pane) => ({
            ...pane,
            term: writeLine(
              ensureNewline(clearIndent(pane.term)),
              text,
              seg(e.ok ? 'ok' : e.skipped || e.cancelled ? 'dim' : 'err')
            )
          }))
          break
        }

        case 'end': {
          lastRunOut.current = null
          const failedName = e.failedNodeId
            ? byId.get(e.failedNodeId)?.name || e.failedNodeId
            : nodes[e.failedAt ?? 0]?.name
          patchRun((r) => {
            const time = fmtTime(r.startedAt)
            return {
              ...r,
              status: e.ok ? 'pass' : 'fail',
              label: e.cancelled
                ? `Cancelled on ${branch} · ${time}`
                : e.ok
                  ? `Passed on ${branch} · ${time}`
                  : `Failed on ${branch} · ${time}`
            }
          })
          const summary = e.cancelled
            ? `■ Cancelled on ${branch}`
            : e.ok
              ? `✔ Passed on ${branch} — all ${total} step${total === 1 ? '' : 's'} succeeded`
              : `✖ Failed on ${branch}` + (failedName ? ` — ${failedName} failed` : '')
          pushLog(
            e.ok ? 'Pipeline finished — all steps passed' : e.cancelled ? 'Pipeline cancelled' : 'Pipeline failed',
            e.ok ? '#5fd39a' : e.cancelled ? '#8b94a3' : '#e07b7b'
          )
          patchTab(tabId, (t) => ({ ...t, status: e.ok ? 'pass' : 'fail' }))
          // Only runs a person started hand off; otherwise an agent that runs
          // a pipeline and fails would spawn another agent, and so on.
          if (!isAgentRun(e.origin) && !e.ok && !e.cancelled && e.reportPath && settingsRef.current.autoFix) {
            const runCwd = tabsRef.current.find((t) => t.id === tabId)?.panes[paneId]?.cwd
            if (runCwd) sendToAgentRef.current(branch, runCwd)
          }
          term((pane) => ({
            ...pane,
            term: writeLine(
              writeLine(ensureNewline(clearIndent(pane.term)), '', {}),
              summary,
              seg(e.ok ? 'ok' : e.cancelled ? 'dim' : 'err')
            )
          }))
          break
        }
      }
    }

    // A talkative test suite emits output line by line, and every line used to
    // be its own render of the whole workspace. Replaying a window's worth in
    // one pass lets React batch them into a single render.
    const queue: RunEvent[] = []
    let timer: number | null = null
    const flush = (): void => {
      timer = null
      const batch = queue.splice(0)
      for (const event of batch) {
        try {
          handle(event)
        } catch (error) {
          console.error('[buildflow] run event failed', event, error)
        }
      }
    }
    const off = api.run.onEvent((event: RunEvent) => {
      const last = queue[queue.length - 1]
      if (
        event.kind === 'output' &&
        last?.kind === 'output' &&
        last.runId === event.runId &&
        last.nodeId === event.nodeId
      ) {
        last.chunk += event.chunk
      } else {
        queue.push(event)
      }
      if (queue.length > MAX_STREAM_QUEUE) queue.splice(0, queue.length - MAX_STREAM_QUEUE)
      if (timer === null) timer = window.setTimeout(flush, STREAM_FLUSH_MS)
    })
    return () => {
      off()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [patchPane, patchTab, pushLog])

  /* ------------------------------------------------------------ shortcuts */

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // The dialog is modal: let it own Escape and Return.
      if (!visible || newTabOpen || editor || paletteOpen) return
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 't') {
        e.preventDefault()
        newShellTab()
      } else if (k === 'd') {
        e.preventDefault()
        // Pane splits when a shell is active; otherwise toggle chat/terminal split.
        const tab = tabsRef.current.find((t) => t.id === activeTab)
        if (tab?.kind === 'shell' && view !== 'chat') {
          splitPane(e.shiftKey ? 'col' : 'row')
        } else {
          setView((v) => (v === 'split' ? 'chat' : 'split'))
        }
      } else if (k === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
      } else if (k === 'w') {
        e.preventDefault()
        if (e.shiftKey && active) {
          closePane(active.id, active.focus)
        } else if (activeTab) {
          closeTab(activeTab)
        }
      } else if (k >= '1' && k <= '9') {
        const tab = termTabs[+k - 1]
        if (tab) {
          e.preventDefault()
          setActiveTab(tab.id)
          setView((v) => (v === 'chat' ? 'split' : v))
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    visible,
    termTabs,
    activeTab,
    active,
    view,
    newTabOpen,
    editor,
    paletteOpen,
    newShellTab,
    splitPane,
    closeTab,
    closePane
  ])

  const saveEditor = useCallback(() => {
    if (!editor || !editor.name.trim() || !editor.nodes.length) return
    const ids = new Set(editor.nodes.map((n) => n.id))
    const nodes = editor.nodes.map((n) => ({
      ...n,
      name: n.name.trim() || n.cmd.trim() || 'Step',
      after: n.after.filter((a) => ids.has(a))
    }))
    if (editor.id) {
      persist(pipelines.map((p) => (p.id === editor.id ? { ...p, name: editor.name.trim(), nodes } : p)))
      setRuns((prev) => {
        const next = { ...prev }
        delete next[editor.id as string]
        return next
      })
      setSelId(editor.id)
    } else {
      const id = `pl${Date.now()}`
      persist([...pipelines, { id, name: editor.name.trim(), nodes }])
      setSelId(id)
    }
    setEditor(null)
  }, [editor, pipelines, persist])

  const stopPipeline = useCallback((id: string, branch?: string) => {
    runStartGen.current[id] = (runStartGen.current[id] ?? 0) + 1
    setRuns((prev) => {
      const byBranch = prev[id]
      if (!byBranch) return prev
      let changed = false
      const next = { ...byBranch }
      for (const [b, r] of Object.entries(next)) {
        if (branch !== undefined && b !== branch) continue
        if (r.status === 'running') {
          next[b] = {
            ...r,
            // Invalidate so late events from this run cannot stick the UI.
            runId: `cancelled:${r.runId}`,
            status: 'fail',
            label: `Cancelled on ${b} · ${fmtTime(r.startedAt)}`
          }
          changed = true
        }
      }
      return changed ? { ...prev, [id]: next } : prev
    })
    setTabs((prev) =>
      prev.map((t) => {
        if (t.kind !== 'run' || t.status !== 'running') return t
        if (!t.id.startsWith(`run:${id}:`)) return t
        if (branch !== undefined && t.branch !== branch) return t
        return { ...t, status: 'fail' }
      })
    )
    void api.run.cancel(runtimePipelineId(id))
  }, [project.path])

  const deletePipeline = useCallback(
    (id: string) => {
      const next = pipelines.filter((p) => p.id !== id)
      persist(next)
      setSelId(next.length ? next[0].id : null)
      // Run tabs exist per branch, so drop every tab belonging to this pipeline.
      const isRunTab = (tabId: string): boolean => tabId.startsWith(`run:${id}:`)
      setTabs((prev) => prev.filter((t) => !isRunTab(t.id)))
      if (isRunTab(activeTab)) {
        setActiveTab(termTabs.find((t) => !isRunTab(t.id))?.id ?? '')
      }
      void api.run.cancel(runtimePipelineId(id))
    },
    [pipelines, persist, activeTab, termTabs]
  )

  const selected = pipelines.find((p) => p.id === selId) ?? null
  const runBranch = project ? branchForTab(active, project.path, git) : git.branch || '—'

  const openRunLogs = useCallback(() => {
    if (!selId) return
    const tab =
      termTabs.find((t) => t.id === `run:${selId}:${runBranch}`) ??
      termTabs.find((t) => t.id.startsWith(`run:${selId}:`))
    if (tab) setActiveTab(tab.id)
    setView('terminal')
  }, [selId, runBranch, termTabs])

  const paletteItems = useMemo((): PaletteItem[] => {
    const items: PaletteItem[] = [
      {
        id: 'view-chat',
        label: 'Chat view',
        group: 'View',
        run: () => setView('chat')
      },
      {
        id: 'view-terminal',
        label: 'Terminal view',
        group: 'View',
        run: () => setView('terminal')
      },
      {
        id: 'view-split',
        label: 'Split view',
        group: 'View',
        run: () => setView('split')
      },
      {
        id: 'new-terminal',
        label: 'New terminal',
        group: 'Actions',
        run: () => newShellTab()
      },
      {
        id: 'open-project',
        label: 'Open project…',
        group: 'Actions',
        run: () => onOpenProject()
      },
      {
        id: 'focus-composer',
        label: 'Focus chat composer',
        group: 'Actions',
        run: () => {
          setView((v) => (v === 'terminal' ? 'split' : v))
          window.setTimeout(() => composerRef.current?.focus(), 0)
        }
      }
    ]
    for (const p of pipelines) {
      items.push({
        id: `run:${p.id}`,
        label: `Run ${p.name}`,
        group: 'Pipelines',
        detail: `${p.nodes.length} steps`,
        run: () => void runPipeline(p.id)
      })
      items.push({
        id: `select:${p.id}`,
        label: p.name,
        group: 'Pipelines',
        detail: 'Select pipeline',
        run: () => {
          setSelId(p.id)
          setPipesCollapsed(false)
        }
      })
    }
    for (const tab of termTabs) {
      items.push({
        id: `tab:${tab.id}`,
        label: tab.title,
        group: 'Tabs',
        detail: tab.kind,
        run: () => {
          setActiveTab(tab.id)
          setView((v) => (v === 'chat' ? 'terminal' : v))
        }
      })
    }
    return items
  }, [pipelines, termTabs, newShellTab, onOpenProject, runPipeline])

  const branchRuns = useMemo(() => {
    const out: Record<string, RunState> = {}
    for (const [pipelineId, byBranch] of Object.entries(runs)) {
      const r = byBranch[runBranch]
      if (r) out[pipelineId] = r
    }
    return out
  }, [runs, runBranch])

  const anyRunning = Object.values(branchRuns).some((r) => r.status === 'running')
  const runningPipelineId = useMemo(() => {
    for (const [pipelineId, byBranch] of Object.entries(runs)) {
      if (byBranch[runBranch]?.status === 'running') return pipelineId
    }
    return null
  }, [runs, runBranch])
  const processCount = termTabs.reduce(
    (count, tab) => count + Object.values(tab.panes).filter((pane) => pane.kind === 'shell').length,
    0
  )

  const cwdLabel = displayPath(active?.panes[active.focus]?.cwd ?? project?.path ?? '', project)

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: liquid ? G.appBg : GRADIENT_BG,
        color: C.text,
        fontFamily: UI,
        fontSize: 13,
        WebkitFontSmoothing: 'antialiased',
        userSelect: 'none',
        overflow: 'hidden'
      }}
    >
      <Toolbar
        liquid={liquid}
        project={project}
        view={view}
        onView={setView}
        onNewTerminal={newShellTab}
        recents={recents}
        menuOpen={menuOpen}
        onMenuToggle={() => {
          setMenuOpen((v) => !v)
          void api.project.recents().then(setRecents)
        }}
        onMenuClose={() => setMenuOpen(false)}
        onOpenProject={onOpenProject}
        onOpenRecent={onOpenPath}
        onCloseProject={onCloseProject}
        updateVersion={updateVersion}
        onInstallUpdate={() => api.update.install()}
        settings={settings}
        onSettings={(next) => {
          setSettings(next)
          void api.settings.save(next)
        }}
      />

      {project && (
        <>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 12, padding: '0 14px 12px' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 12 }}>
              {view !== 'terminal' && (
                <ErrorBoundary compact>
                  <ChatPane
                    key={`${project.path}:${chatOwner?.id ?? 'chat'}`}
                    pane={chatPane}
                    pipelines={pipelines}
                    view={view}
                    projectPath={project.path}
                    defaultProvider={settings.agent}
                    onMessage={sendAgentMessage}
                    onCancel={cancelAgent}
                    onProviderChange={setAgentProvider}
                    onOpenPipeline={(tabId) => showTerminal(tabId, 'terminal')}
                    onNewChat={requestNewChat}
                    clearChatConfirm={clearChatConfirm}
                    onConfirmClearChat={() => clearChat(true)}
                    onCancelClearChat={() => setClearChatConfirm(false)}
                    chatClearedNotice={chatClearedNotice}
                    onDismissChatCleared={() => setChatClearedNotice(false)}
                    composerRef={composerRef}
                  />
                </ErrorBoundary>
              )}
              {/* Keep terminals mounted in Chat view so PTY scrollback is not lost. */}
              <div
                style={{
                  flex: view === 'split' ? '1 1 50%' : '1 1 100%',
                  minWidth: 0,
                  minHeight: 0,
                  display: view === 'chat' ? 'none' : 'flex',
                  flexDirection: 'column'
                }}
                aria-hidden={view === 'chat'}
              >
                <TerminalPane
                  key={project.path}
                  tabs={termTabs}
                  activeId={active?.id ?? ''}
                  view={view === 'chat' ? 'terminal' : view}
                  workspaceVisible={visible && view !== 'chat'}
                  branch={runBranch}
                  cwd={cwdLabel}
                  onSelect={setActiveTab}
                  onClose={closeTab}
                  onNew={newShellTab}
                  onFocusPane={(tabId, paneId) =>
                    patchTab(tabId, (tab) => (tab.focus === paneId ? tab : { ...tab, focus: paneId }))
                  }
                  onClosePane={closePane}
                  onResize={(tabId, nodeId, size) =>
                    patchTab(tabId, (tab) => ({
                      ...tab,
                      root: setSize(tab.root, nodeId, size)
                    }))
                  }
                  onSplitRight={() => splitPane('row')}
                  onSplitDown={() => splitPane('col')}
                  canSplit={
                    !!active &&
                    active.kind === 'shell' &&
                    active.panes[active.focus]?.kind === 'shell'
                  }
                />
              </div>
            </div>

            <Sidebar
              pipelines={pipelines}
              runs={branchRuns}
              logs={detailLogs}
              selected={selected}
              onSelect={(id) => {
                setSelId(id)
                setEditor(null)
              }}
              onNew={() => setEditor({ id: null, name: '', nodes: [blankNode()] })}
              onRun={runPipeline}
              onStop={(id) => stopPipeline(id, runBranch)}
              onEdit={(p) => setEditor({ id: p.id, name: p.name, nodes: p.nodes.map((n) => ({ ...n })) })}
              onDelete={deletePipeline}
              onOpenTerminal={openRunLogs}
              collapsed={pipesCollapsed}
              onSetCollapsed={setPipesCollapsed}
            />
          </div>

          <StatusBar
            branch={git.isRepo ? runBranch : ''}
            running={anyRunning}
            runningLabel={anyRunning ? 'Pipeline running' : 'Idle'}
            processCount={processCount}
            onBranch={() => void openBranchDialog()}
            onStop={runningPipelineId ? () => stopPipeline(runningPipelineId, runBranch) : undefined}
          />
        </>
      )}

      <CommandPalette open={paletteOpen} items={paletteItems} onClose={() => setPaletteOpen(false)} />

      {newTabOpen && project && (
        <NewTabDialog
          liquid={liquid}
          git={git}
          projectPath={project.path}
          repoName={project.name}
          busy={creating}
          error={newTabError}
          onCancel={() => setNewTabOpen(false)}
          onOpenExisting={openExistingWorktree}
          onCreate={(req) => void createBranchProject(req)}
        />
      )}

      {editor && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            // Above the app toolbar (zIndex 30) so Save/Cancel stay clickable.
            zIndex: 80,
            display: 'flex',
            flexDirection: 'column',
            background: '#07090d'
          }}
        >
          <PipelineCanvas
            editor={editor}
            onChange={setEditor}
            onCancel={() => setEditor(null)}
            onSave={saveEditor}
          />
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [projectsCollapsed, setProjectsCollapsed] = useState(false)
  const [branchDialog, setBranchDialog] = useState<{ path: string; nonce: number }>({
    path: '',
    nonce: 0
  })
  const [chatRequest, setChatRequest] = useState<{ path: string; nonce: number }>({
    path: '',
    nonce: 0
  })
  const [agentBusyPaths, setAgentBusyPaths] = useState<ReadonlySet<string>>(() => new Set())
  const hydrated = useRef(false)

  const setAgentBusy = useCallback((projectPath: string, busy: boolean) => {
    setAgentBusyPaths((prev) => {
      const has = prev.has(projectPath)
      if (busy === has) return prev
      const next = new Set(prev)
      if (busy) next.add(projectPath)
      else next.delete(projectPath)
      return next
    })
  }, [])

  const activateProject = useCallback((project: Project) => {
    setProjects((prev) =>
      prev.some((item) => normPath(item.path) === normPath(project.path)) ? prev : [...prev, project]
    )
    setActivePath(project.path)
  }, [])

  const openProject = useCallback(async () => {
    const project = await api.project.open()
    if (project) activateProject(project)
  }, [activateProject])

  const openPath = useCallback(
    async (projectPath: string) => {
      const existing = projects.find((item) => normPath(item.path) === normPath(projectPath))
      if (existing) {
        setActivePath(existing.path)
        return
      }
      const project = await api.project.openPath(projectPath)
      if (project) activateProject(project)
    },
    [projects, activateProject]
  )

  const closeProject = useCallback(
    (projectPath: string) => {
      setProjects((prev) => {
        const index = prev.findIndex((item) => item.path === projectPath)
        const next = prev.filter((item) => item.path !== projectPath)
        if (activePath === projectPath) {
          setActivePath(next[Math.min(index, next.length - 1)]?.path ?? null)
        }
        return next
      })
    },
    [activePath]
  )

  const requestBranchDialog = useCallback((projectPath: string) => {
    setActivePath(projectPath)
    setBranchDialog((prev) => ({ path: projectPath, nonce: prev.nonce + 1 }))
  }, [])

  const requestNewChat = useCallback((projectPath: string) => {
    setActivePath(projectPath)
    setChatRequest((prev) => ({ path: projectPath, nonce: prev.nonce + 1 }))
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const workspace = await api.session.openProjects()
      const restored = (
        await Promise.all(workspace.paths.map((projectPath) => api.project.openPath(projectPath)))
      ).filter((project): project is Project => project !== null)
      if (cancelled) return
      setProjects(restored)
      setActivePath(
        restored.find((project) => project.path === workspace.activePath)?.path ??
          restored[0]?.path ??
          null
      )
      hydrated.current = true
    })()
    const off = api.project.onOpened(activateProject)
    return () => {
      cancelled = true
      off()
    }
  }, [activateProject])

  useEffect(() => {
    if (!hydrated.current || !projects.length) return
    if (!activePath || !projects.some((project) => normPath(project.path) === normPath(activePath))) {
      setActivePath(projects[0]!.path)
    }
  }, [projects, activePath])

  useEffect(() => {
    if (!hydrated.current) return
    void api.session.saveOpenProjects(
      projects.map((project) => project.path),
      activePath
    )
  }, [projects, activePath])

  if (!projects.length) {
    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          background: GRADIENT_BG,
          color: C.text,
          fontFamily: UI
        }}
      >
        <div
          style={{
            height: 52,
            flex: 'none',
            WebkitAppRegion: 'drag',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            padding: '0 16px'
          } as React.CSSProperties}
        >
          <button
            type="button"
            className="bf-focus bf-icon-btn"
            onClick={openProject}
            title="Open repository…"
            aria-label="Open repository"
            style={{
              WebkitAppRegion: 'no-drag',
              width: 28,
              height: 28,
              borderRadius: 7,
              border: `1px solid ${C.border}`,
              background: C.card,
              color: C.text,
              display: 'grid',
              placeItems: 'center',
              cursor: 'pointer'
            } as React.CSSProperties}
          >
            <FolderPlusIcon size={14} />
          </button>
        </div>
        <EmptyState onOpenProject={openProject} />
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        background: GRADIENT_BG
      }}
    >
      <ProjectRail
        projects={projects}
        activePath={activePath}
        busyPaths={agentBusyPaths}
        onSelect={setActivePath}
        onClose={closeProject}
        onNewBranch={requestBranchDialog}
        onNewChat={requestNewChat}
        collapsed={projectsCollapsed}
        onSetCollapsed={setProjectsCollapsed}
      />
      <div style={{ position: 'relative', flex: 1, minWidth: 0, overflow: 'hidden' }}>
        {projects.map((project) => {
          const visible = normPath(project.path) === normPath(activePath ?? '')
          return (
            <div
              key={project.path}
              aria-hidden={!visible}
              // Keep every repository mounted for instant switches, but park
              // inactive ones off-screen. `visibility: hidden` alone is not
              // enough: xterm canvases can still paint through in Electron.
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: visible ? 1 : 0,
                // Avoid `transform` on the visible workspace so portaled UI
                // (⌘K, menus) is not trapped in a containing block.
                ...(visible
                  ? { visibility: 'visible' as const, pointerEvents: 'auto' as const }
                  : {
                      visibility: 'hidden' as const,
                      pointerEvents: 'none' as const,
                      transform: 'translateX(-120%)'
                    })
              }}
            >
              <ProjectWorkspace
                project={project}
                visible={visible}
                branchDialogNonce={
                  branchDialog.path === project.path ? branchDialog.nonce : 0
                }
                newChatNonce={chatRequest.path === project.path ? chatRequest.nonce : 0}
                onOpenProject={openProject}
                onOpenPath={(path) => void openPath(path)}
                onCloseProject={() => closeProject(project.path)}
                onAgentBusyChange={setAgentBusy}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
