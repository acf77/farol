import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import { createPortal } from 'react-dom'
import type {
  AgentMode,
  AgentTaskEvent,
  AiProvider,
  AppSettings,
  GitInfo,
  Pipeline,
  PipelineNode,
  ProviderUsage,
  Project,
  ProjectSession,
  RunEvent,
  RunOrigin,
  StepState,
  WorktreeRequest
} from '@shared/types'
import { AI_LABELS, aiFixPrompt, normalizeMode } from '@shared/ai'
import { isFinishedPlan, sanitizePlan } from '@shared/questions'
import {
  defaultSettings,
  modeDefault,
  modeFallbacks,
  withAgentModel,
  withCommitMessageModel
} from '@shared/settings'
import { sessionSeq } from '@shared/session'
import { owningWorktree } from '@shared/worktree'
import { scopedRuntimeId, unscopedRuntimeId } from '@shared/runtime'
import { topoSort } from '@shared/graph'
import { clearIndent, emptyTerm, ensureNewline, setIndent, trimTo, write, writeLine } from './ansi'
import { agentPaneFor, chatOwnerFor, chatTabFor, trimAgentMessages } from './chat-context'
import { fmtDuration, pipelineActivityText, projectRunChat } from './pipeline-chat'
import { bindLatestRunId, bindRunStart, runOutcomeLabel, syncAgentPipelineRun } from './run-slot'
import { CHROME_ROW, PANEL_INSET } from './components/side-panel'
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
import GitPane, { gitStatusDotColor } from './components/GitPane'
import { useGitPanel, type GitLogEntry } from './hooks/useGitPanel'
import PipelineCanvas from './components/PipelineCanvas'
import CommandPalette, { type PaletteItem } from './components/CommandPalette'
import SettingsPage from './components/SettingsPage'
import { useUsage } from './hooks/useUsage'
import { FolderPlusIcon } from './components/icons'

const api = window.farol
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
const NO_GIT: GitInfo = { isRepo: false, branch: '', branches: [] }

type GitControl = {
  dotColor: string
  busy: boolean
  pulling: boolean
  pullResult: GitLogEntry | undefined
  pull: ReturnType<typeof useGitPanel>['pull']
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

function sanitizeAgentMessage(message: AgentMessage): AgentMessage {
  const plan = sanitizePlan(message.plan)
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
      : {}),
    ...(message.question
      ? {
          question: {
            ...message.question,
            requestId: asText(message.question.requestId)
          }
        }
      : {}),
    ...(plan ? { plan } : {})
  }
}

function planMessage(message: AgentMessage, mode: AgentMode): AgentMessage {
  if (mode !== 'plan' || message.role !== 'assistant') return message
  if (isFinishedPlan(message.text)) return { ...message, plan: { finished: true } }
  return message.plan ? { ...message, plan: undefined } : message
}

/**
 * Mark finished plans as consumed — once a plan is executed or superseded, it can't be replayed.
 * With `onlyIndex`, only that message is touched; otherwise every finished plan is.
 */
function consumePlans(messages: AgentMessage[], onlyIndex?: number): AgentMessage[] {
  return messages.map((message, i) =>
    (onlyIndex === undefined || i === onlyIndex) && message.plan?.finished && !message.plan.consumed
      ? { ...message, plan: { ...message.plan, consumed: true as const } }
      : message
  )
}

/** Managed Chat and MCP runs share agent semantics — not manual UI runs. */
function isAgentRun(origin: RunOrigin): boolean {
  return origin === 'agent' || origin === 'managed-agent'
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

function runLogTab(pipeline: Pipeline, pipelineId: string, branch: string, cwd: string): Tab {
  const paneId = `rp:${pipelineId}:${branch}`
  return {
    id: `run:${pipelineId}:${branch}`,
    kind: 'run',
    title: pipeline.name,
    status: 'running',
    branch,
    root: leaf(paneId),
    focus: paneId,
    panes: {
      [paneId]: { id: paneId, kind: 'run', title: pipeline.name, cwd, term: emptyTerm() }
    }
  }
}

/** `HH:MM:SS`, the stamp the pipelines rail puts beside each log line. */
function clockStamp(): string {
  const d = new Date()
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

function shellPane(id: string, cwd: string, agent?: AiProvider): Pane {
  // No buffer, no input state: xterm.js and the PTY own everything a shell
  // pane does. Farol only tracks where it is, for the title bar.
  return {
    id,
    kind: 'shell',
    title: agent ? AI_LABELS[agent] : api.shellName,
    cwd,
    ...(agent ? { agent } : {})
  }
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
              mode: normalizeMode(p.mode, p.provider),
              ...(p.model ? { model: p.model } : {}),
              messages: trimAgentMessages(
                [
                  ...p.messages,
                  ...(p.status === 'idle' || p.status === 'completed' || p.status === 'cancelled'
                    ? []
                    : [
                        {
                          role: 'system' as const,
                          text: 'Farol restarted. This managed process stopped; start a new chat to continue.'
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
                mode: p.mode,
                ...(p.model ? { model: p.model } : {}),
                // A restored transcript is for reading, not for replaying a
                // whole run's output — the workspace file is rewritten often.
                messages: p.messages.map((m) => ({
                  role: m.role,
                  text: m.text.length > MAX_SAVED_CHARS ? m.text.slice(-MAX_SAVED_CHARS) : m.text,
                  ...(m.plan ? { plan: m.plan } : {})
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
  return owningWorktree(cwd, git.worktrees ?? [])?.branch || git.branch || '—'
}

function agentChatTab(owner: Tab, project: Project, branch: string, settings: AppSettings): Tab {
  const cwd = owner.panes[owner.focus]?.cwd || project.path
  const { agent, model } = modeDefault(settings, 'build')
  const taskId = scopedRuntimeId(project.path, `agent:${owner.id}:${Date.now()}`)
  const paneId = `ap:${taskId}`
  return {
    id: taskId,
    kind: 'agent',
    title: 'Chat',
    status: null,
    ownerTabId: owner.id,
    branch,
    root: leaf(paneId),
    focus: paneId,
    panes: {
      [paneId]: {
        id: paneId,
        kind: 'agent',
        title: 'Chat',
        cwd,
        taskId,
        status: 'idle',
        attempt: 0,
        provider: agent,
        mode: 'build',
        ...(model ? { model } : {}),
        messages: []
      }
    }
  }
}

function appendAgentMessages(pane: AgentPane, messages: AgentMessage[]): AgentPane {
  return {
    ...pane,
    messages: trimAgentMessages(messages.map(sanitizeAgentMessage))
  }
}

function applyAgentOutputEvent(
  pane: AgentPane,
  event: Extract<AgentTaskEvent, { kind: 'output' }>
): AgentPane {
  const chunk = asText(event.chunk)
  const messages = [...pane.messages]
  const last = messages[messages.length - 1]
  // Only plain prose keeps growing; a card or an oversized turn is closed.
  if (
    last?.role === 'assistant' &&
    !last.tool &&
    !last.pipeline &&
    !last.question &&
    asText(last.text).length < MAX_MESSAGE_CHARS
  ) {
    messages[messages.length - 1] = planMessage(
      { ...last, text: asText(last.text) + chunk },
      pane.mode
    )
  } else {
    messages.push(planMessage({ role: 'assistant', text: chunk }, pane.mode))
  }
  return appendAgentMessages(pane, messages)
}

function applyAgentQuestionEvent(
  pane: AgentPane,
  event: Extract<AgentTaskEvent, { kind: 'question' }>
): AgentPane {
  const card = {
    requestId: event.requestId,
    questions: event.questions,
    ...(event.answers ? { answers: event.answers } : {}),
    ...(event.dismissed ? { dismissed: true } : {})
  }
  const message = {
    role: 'system' as const,
    text: event.dismissed
      ? 'Questions dismissed'
      : event.answers
        ? event.questions
            .map((q, i) => `${q.header}: ${(event.answers?.[i] ?? []).join(', ')}`)
            .join('; ')
        : event.questions.map((q) => q.header).join(', '),
    question: card
  }
  const messages = [...pane.messages]
  let existing = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].question?.requestId === event.requestId) {
      existing = i
      break
    }
  }
  if (existing >= 0) messages[existing] = message
  else messages.push(message)
  return appendAgentMessages(pane, messages)
}

function applyAgentToolEvent(
  pane: AgentPane,
  event: Extract<AgentTaskEvent, { kind: 'tool' }>
): AgentPane {
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
  return appendAgentMessages(pane, messages)
}

function applyAgentPipelineEvent(
  pane: AgentPane,
  event: Extract<AgentTaskEvent, { kind: 'pipeline' }>,
  localPipelineId: (runtimeId: string) => string | null,
  tabs: Tab[],
  project: Project | null,
  git: GitInfo
): AgentPane {
  // The tab a pipeline run streams to is addressed the same way
  // runPipeline() addresses one it started directly — by pipeline
  // and the branch the owning tab is on.
  const owner = tabs.find((t) =>
    Object.values(t.panes).some((p) => p.kind === 'agent' && p.taskId === event.taskId)
  )
  const branch = owner && project ? branchForTab(owner, project.path, git) : ''
  const pipelineId = localPipelineId(event.pipelineId) ?? event.pipelineId
  const pipeline = {
    runId: event.runId,
    pipelineId,
    pipelineName: event.pipelineName,
    status: event.status,
    startedAt: event.startedAt,
    finishedAt: event.finishedAt,
    durationMs: event.durationMs,
    tabId: `run:${pipelineId}:${branch}`
  }
  const message = {
    role: 'system' as const,
    text: pipelineActivityText(pipeline),
    pipeline
  }
  const messages = [...pane.messages]
  let existing = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const card = messages[i].pipeline
    if (card?.pipelineId === pipelineId && card.startedAt === event.startedAt) {
      existing = i
      break
    }
  }
  if (existing >= 0) messages[existing] = message
  else messages.push(message)
  return appendAgentMessages(pane, messages)
}

function applyAgentStatusEvent(
  pane: AgentPane,
  event: Extract<AgentTaskEvent, { kind: 'status' }>
): AgentPane {
  const announce =
    event.status !== 'validating' && event.status !== 'completed' && event.status !== 'asking'
  const message = asText(event.message)
  return {
    ...pane,
    status: event.status,
    attempt: event.attempt,
    messages: announce
      ? trimAgentMessages([...pane.messages, { role: 'system', text: message }])
      : pane.messages
  }
}

/** Fold one agent-stream event into the pane transcript. */
function applyAgentEvent(
  pane: AgentPane,
  event: AgentTaskEvent,
  localPipelineId: (runtimeId: string) => string | null,
  tabs: Tab[],
  project: Project | null,
  git: GitInfo
): AgentPane {
  if (event.kind === 'output') return applyAgentOutputEvent(pane, event)
  if (event.kind === 'assistant') {
    return appendAgentMessages(pane, [
      ...pane.messages,
      planMessage({ role: 'assistant', text: asText(event.text) }, pane.mode)
    ])
  }
  if (event.kind === 'tool') return applyAgentToolEvent(pane, event)
  if (event.kind === 'question') return applyAgentQuestionEvent(pane, event)
  if (event.kind === 'user') {
    return appendAgentMessages(pane, [
      ...pane.messages,
      { role: 'user', text: asText(event.text), at: Date.now() }
    ])
  }
  if (event.kind === 'provider') {
    return appendAgentMessages(
      { ...pane, provider: event.provider, model: event.model, mode: event.mode },
      [...pane.messages, { role: 'system', text: asText(event.reason) }]
    )
  }
  if (event.kind === 'pipeline') {
    // Runner start/end owns the card. Only start-failed pipelines (error:) never emit a RunEvent.
    if (!event.runId?.startsWith('error:')) return pane
    return applyAgentPipelineEvent(pane, event, localPipelineId, tabs, project, git)
  }
  return applyAgentStatusEvent(pane, event)
}

type LastRunOut = { paneId: string; nodeId: string } | null

interface RunEventHandlerDeps {
  localPipelineId: (runtimeId: string) => string | null
  pipelines: Pipeline[]
  lastRunOut: { current: LastRunOut }
  patchPane: (paneId: string, fn: (p: Pane) => Pane) => void
  patchTab: (tabId: string, fn: (t: Tab) => Tab) => void
  pushLog: (text: string, color: string) => void
  setRuns: Dispatch<SetStateAction<RunsByBranch>>
  setTabs: Dispatch<SetStateAction<Tab[]>>
  setSelId: Dispatch<SetStateAction<string | null>>
  settingsRef: { current: AppSettings }
  tabsRef: { current: Tab[] }
  sendToAgentRef: { current: (branch: string, cwd: string) => void }
}

interface RunEventCtx {
  pipelineId: string
  branch: string
  tabId: string
  paneId: string
  pipeline: Pipeline
  nodes: PipelineNode[]
  byId: Map<string, PipelineNode>
  total: number
  deps: RunEventHandlerDeps
  term: (fn: (pane: RunPane) => RunPane) => void
  patchRun: (fn: (r: RunState) => RunState) => void
  stepAt: (nodeId: string, v: StepState) => void
}

function handleRunStart(ctx: RunEventCtx, e: Extract<RunEvent, { kind: 'start' }>): void {
  const { pipelineId, branch, tabId, pipeline: p, nodes, total, deps, term } = ctx
  deps.lastRunOut.current = null
  deps.setTabs((prev) => {
    const fresh = runLogTab(p, pipelineId, branch, e.cwd)
    return prev.some((tab) => tab.id === tabId)
      ? prev.map((tab) => tab.id === tabId ? fresh : tab)
      : [...prev, fresh]
  })
  deps.setSelId(pipelineId)
  deps.setRuns((prev) => bindRunStart(prev, pipelineId, branch, e, nodes))
  deps.patchTab(tabId, (t) => ({ ...t, status: 'running' }))
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
}

function handleRunStepStart(ctx: RunEventCtx, e: Extract<RunEvent, { kind: 'step-start' }>): void {
  const { byId, total, deps, term, stepAt } = ctx
  deps.lastRunOut.current = null
  const name = byId.get(e.nodeId)?.name || e.nodeId
  stepAt(e.nodeId, 'running')
  deps.pushLog(`Starting step: ${name}`, '#A1A19A')
  term((pane) => ({
    ...pane,
    term: writeLine(ensureNewline(clearIndent(pane.term)), `[${e.index + 1}/${total}] ${name}`, seg('step'))
  }))
}

function handleRunOutput(ctx: RunEventCtx, e: Extract<RunEvent, { kind: 'output' }>): void {
  const { paneId, byId, deps, term } = ctx
  const name = byId.get(e.nodeId)?.name || e.nodeId
  const prefix = nodeLogPrefix(name)
  const switched =
    deps.lastRunOut.current?.paneId !== paneId || deps.lastRunOut.current?.nodeId !== e.nodeId
  deps.lastRunOut.current = { paneId, nodeId: e.nodeId }
  term((pane) => {
    const t = switched ? setIndent(ensureNewline(clearIndent(pane.term)), prefix) : pane.term
    return { ...pane, term: trimTo(write(t, e.chunk), MAX_LINES) }
  })
}

function stepEndState(e: Extract<RunEvent, { kind: 'step-end' }>): StepState {
  if (e.skipped) return 'skip'
  if (e.ok) return 'pass'
  if (e.cancelled) return 'skip'
  return 'fail'
}

function stepEndText(name: string, e: Extract<RunEvent, { kind: 'step-end' }>): string {
  if (e.skipped) return `– ${name} skipped`
  if (e.ok) return `✓ ${name} (${fmtDuration(e.durationMs)})`
  if (e.cancelled) return `■ ${name} cancelled`
  return `✗ ${name} (${fmtDuration(e.durationMs)}) — exit code ${e.code}`
}

function handleRunStepEnd(ctx: RunEventCtx, e: Extract<RunEvent, { kind: 'step-end' }>): void {
  const { byId, deps, term, stepAt } = ctx
  deps.lastRunOut.current = null
  const st = stepEndState(e)
  stepAt(e.nodeId, st)
  const name = byId.get(e.nodeId)?.name || e.nodeId
  const text = stepEndText(name, e)
  const color = e.ok ? '#87C9AE' : e.skipped || e.cancelled ? '#A1A19A' : '#FF625A'
  deps.pushLog(text, color)
  term((pane) => ({
    ...pane,
    term: writeLine(
      ensureNewline(clearIndent(pane.term)),
      text,
      seg(e.ok ? 'ok' : e.skipped || e.cancelled ? 'dim' : 'err')
    )
  }))
}

function runEndSummary(
  branch: string,
  total: number,
  failedName: string | undefined,
  e: Extract<RunEvent, { kind: 'end' }>
): string {
  if (e.cancelled) return `■ Cancelled on ${branch}`
  if (e.ok) return `✔ Passed on ${branch} — all ${total} step${total === 1 ? '' : 's'} succeeded`
  return `✖ Failed on ${branch}` + (failedName ? ` — ${failedName} failed` : '')
}

function handleRunEnd(ctx: RunEventCtx, e: Extract<RunEvent, { kind: 'end' }>): void {
  const { branch, tabId, paneId, nodes, byId, total, deps, term, patchRun } = ctx
  deps.lastRunOut.current = null
  const failedName = e.failedNodeId
    ? byId.get(e.failedNodeId)?.name || e.failedNodeId
    : nodes[e.failedAt ?? 0]?.name
  patchRun((r) => {
    const time = fmtTime(r.startedAt)
    return {
      ...r,
      status: e.cancelled ? 'cancelled' : e.ok ? 'pass' : 'fail',
      label: runOutcomeLabel(e.cancelled ? 'cancelled' : e.ok ? 'pass' : 'fail', branch, time)
    }
  })
  const summary = runEndSummary(branch, total, failedName, e)
  deps.pushLog(
    e.ok ? 'Pipeline finished — all steps passed' : e.cancelled ? 'Pipeline cancelled' : 'Pipeline failed',
    e.ok ? '#87C9AE' : e.cancelled ? '#A1A19A' : '#FF625A'
  )
  deps.patchTab(tabId, (t) => ({ ...t, status: e.cancelled ? 'cancelled' : e.ok ? 'pass' : 'fail' }))
  // Only runs a person started hand off; otherwise an agent that runs
  // a pipeline and fails would spawn another agent, and so on.
  if (!isAgentRun(e.origin) && !e.ok && !e.cancelled && e.reportPath && deps.settingsRef.current.autoFix) {
    const runCwd = deps.tabsRef.current.find((t) => t.id === tabId)?.panes[paneId]?.cwd
    if (runCwd) deps.sendToAgentRef.current(branch, runCwd)
  }
  term((pane) => ({
    ...pane,
    term: writeLine(
      writeLine(ensureNewline(clearIndent(pane.term)), '', {}),
      summary,
      seg(e.ok ? 'ok' : e.cancelled ? 'dim' : 'err')
    )
  }))
}

function handleRunEvent(e: RunEvent, deps: RunEventHandlerDeps): void {
  const pipelineId = deps.localPipelineId(e.pipelineId)
  if (!pipelineId) return
  const p = deps.pipelines.find((x) => x.id === pipelineId)
  if (!p) return
  const { branch } = e
  const tabId = `run:${pipelineId}:${branch}`
  const paneId = `rp:${pipelineId}:${branch}`
  const nodes = topoSort(p.nodes) ?? p.nodes
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const total = nodes.length

  const term = (fn: (pane: RunPane) => RunPane): void =>
    deps.patchPane(paneId, (pane) => (pane.kind === 'run' ? fn(pane) : pane))
  const patchRun = (fn: (r: RunState) => RunState): void =>
    deps.setRuns((prev) => {
      const cur = prev[pipelineId]?.[branch]
      if (!cur) return prev
      // Ignore output from a cancelled predecessor after a newer run was queued.
      if (cur.runId !== e.runId) return prev
      return { ...prev, [pipelineId]: { ...prev[pipelineId], [branch]: fn(cur) } }
    })
  const stepAt = (nodeId: string, v: StepState): void =>
    patchRun((r) => ({ ...r, stepResults: { ...r.stepResults, [nodeId]: v } }))

  const ctx: RunEventCtx = {
    pipelineId,
    branch,
    tabId,
    paneId,
    pipeline: p,
    nodes,
    byId,
    total,
    deps,
    term,
    patchRun,
    stepAt
  }

  switch (e.kind) {
    case 'start':
      handleRunStart(ctx, e)
      break
    case 'step-start':
      handleRunStepStart(ctx, e)
      break
    case 'output':
      handleRunOutput(ctx, e)
      break
    case 'step-end':
      handleRunStepEnd(ctx, e)
      break
    case 'end':
      handleRunEnd(ctx, e)
      break
  }
}

interface WorkspaceKeyCtx {
  visible: boolean
  newTabOpen: boolean
  editor: EditorState | null
  paletteOpen: boolean
  settingsOpen: boolean
  gitOpen: boolean
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  activeTab: string
  active: Tab | undefined
  view: View
  termTabs: Tab[]
  tabsRef: { current: Tab[] }
  newShellTab: () => void
  splitPane: (dir: 'row' | 'col') => void
  closePane: (tabId: string, paneId: string) => void
  closeTab: (id: string) => void
  setView: Dispatch<SetStateAction<View>>
  setPaletteOpen: Dispatch<SetStateAction<boolean>>
  setActiveTab: Dispatch<SetStateAction<string>>
}

function handleSplitShortcut(e: KeyboardEvent, ctx: WorkspaceKeyCtx): void {
  e.preventDefault()
  // Pane splits when a shell is active; otherwise toggle chat/terminal split.
  const tab = ctx.tabsRef.current.find((t) => t.id === ctx.activeTab)
  if (tab?.kind === 'shell' && ctx.view !== 'chat') {
    ctx.splitPane(e.shiftKey ? 'col' : 'row')
  } else {
    ctx.setView((v) => (v === 'split' ? 'chat' : 'split'))
  }
}

function handleCloseShortcut(e: KeyboardEvent, ctx: WorkspaceKeyCtx): void {
  e.preventDefault()
  if (e.shiftKey && ctx.active) {
    ctx.closePane(ctx.active.id, ctx.active.focus)
  } else if (ctx.activeTab) {
    ctx.closeTab(ctx.activeTab)
  }
}

function handleDigitShortcut(e: KeyboardEvent, ctx: WorkspaceKeyCtx, digit: string): void {
  const tab = ctx.termTabs[+digit - 1]
  if (!tab) return
  e.preventDefault()
  ctx.setActiveTab(tab.id)
  ctx.setView((v) => (v === 'chat' ? 'split' : v))
}

function handleWorkspaceKeyDown(e: KeyboardEvent, ctx: WorkspaceKeyCtx): void {
  // The dialog is modal: let it own Escape and Return.
  if (
    !ctx.visible ||
    ctx.newTabOpen ||
    ctx.editor ||
    ctx.paletteOpen ||
    ctx.settingsOpen ||
    ctx.gitOpen
  ) return
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return
  const k = e.key.toLowerCase()
  if (k === ',') {
    e.preventDefault()
    ctx.setSettingsOpen(true)
    return
  }
  if (k === 't') {
    e.preventDefault()
    ctx.newShellTab()
    return
  }
  if (k === 'd') {
    handleSplitShortcut(e, ctx)
    return
  }
  if (k === 'k') {
    e.preventDefault()
    ctx.setPaletteOpen(true)
    return
  }
  if (k === 'w') {
    handleCloseShortcut(e, ctx)
    return
  }
  if (k >= '1' && k <= '9') handleDigitShortcut(e, ctx, k)
}

function resolveRunBranch(project: Project | null, active: Tab | undefined, git: GitInfo): string {
  if (project) return branchForTab(active, project.path, git)
  return git.branch || '—'
}

interface ProjectWorkspaceViewProps {
  liquid: boolean
  project: Project
  visible: boolean
  view: View
  setView: Dispatch<SetStateAction<View>>
  newShellTab: () => void
  recents: Project[]
  menuOpen: boolean
  setMenuOpen: Dispatch<SetStateAction<boolean>>
  setRecents: Dispatch<SetStateAction<Project[]>>
  onOpenProject: () => void
  onOpenPath: (path: string) => void
  onCloseProject: () => void
  updateVersion: string | null
  settings: AppSettings
  setSettings: Dispatch<SetStateAction<AppSettings>>
  usage: ProviderUsage[]
  onRefreshUsage: () => void
  chatOwner: Tab | undefined
  chatPane: AgentPane | null
  pipelines: Pipeline[]
  sendAgentMessage: (
    text: string,
    providerOverride?: AppSettings['agent'],
    ownerOverride?: Tab,
    cwdOverride?: string,
    modelOverride?: string | null,
    modeOverride?: AgentMode
  ) => void
  cancelAgent: () => void
  setAgentProvider: (provider: AppSettings['agent'], model?: string) => void
  setAgentMode: (mode: AgentMode) => void
  executePlan: (index: number) => void
  showTerminal: (tabId?: string, mode?: 'split' | 'terminal') => void
  requestNewChat: () => void
  clearChatConfirm: boolean
  clearChat: (hadMessages?: boolean) => void
  setClearChatConfirm: Dispatch<SetStateAction<boolean>>
  chatClearedNotice: boolean
  setChatClearedNotice: Dispatch<SetStateAction<boolean>>
  composerRef: RefObject<HTMLTextAreaElement>
  termTabs: Tab[]
  active: Tab | undefined
  runBranch: string
  cwdLabel: string
  setActiveTab: Dispatch<SetStateAction<string>>
  closeTab: (id: string) => void
  patchTab: (tabId: string, fn: (t: Tab) => Tab) => void
  closePane: (tabId: string, paneId: string) => void
  splitPane: (dir: 'row' | 'col') => void
  branchRuns: Record<string, RunState>
  detailLogs: DetailLog[]
  selected: Pipeline | null
  setSelId: Dispatch<SetStateAction<string | null>>
  setEditor: Dispatch<SetStateAction<EditorState | null>>
  runPipeline: (pipelineId: string) => void
  stopPipeline: (id: string, branch?: string) => void
  deletePipeline: (id: string) => void
  openRunLogs: () => void
  pipesCollapsed: boolean
  setPipesCollapsed: Dispatch<SetStateAction<boolean>>
  gitOpen: boolean
  onGitOpenChange: Dispatch<SetStateAction<boolean>>
  gitAnchorRef: RefObject<HTMLButtonElement>
  gitPanel: ReturnType<typeof useGitPanel>
  git: GitInfo
  paletteOpen: boolean
  paletteItems: PaletteItem[]
  setPaletteOpen: Dispatch<SetStateAction<boolean>>
  settingsOpen: boolean
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  newTabOpen: boolean
  creating: boolean
  newTabError: string | null
  setNewTabOpen: Dispatch<SetStateAction<boolean>>
  openExistingWorktree: (branch: string) => void
  createBranchProject: (req: WorktreeRequest) => void
  editor: EditorState | null
  saveEditor: () => void
}

function ProjectWorkspaceView(props: ProjectWorkspaceViewProps) {
  const {
    liquid,
    project,
    visible,
    view,
    setView,
    newShellTab,
    recents,
    menuOpen,
    setMenuOpen,
    setRecents,
    onOpenProject,
    onOpenPath,
    onCloseProject,
    updateVersion,
    settings,
    setSettings,
    usage,
    onRefreshUsage,
    chatOwner,
    chatPane,
    pipelines,
    sendAgentMessage,
    cancelAgent,
    setAgentProvider,
    setAgentMode,
    executePlan,
    showTerminal,
    requestNewChat,
    clearChatConfirm,
    clearChat,
    setClearChatConfirm,
    chatClearedNotice,
    setChatClearedNotice,
    composerRef,
    termTabs,
    active,
    runBranch,
    cwdLabel,
    setActiveTab,
    closeTab,
    patchTab,
    closePane,
    splitPane,
    branchRuns,
    detailLogs,
    selected,
    setSelId,
    setEditor,
    runPipeline,
    stopPipeline,
    deletePipeline,
    openRunLogs,
    pipesCollapsed,
    setPipesCollapsed,
    gitOpen,
    onGitOpenChange,
    gitAnchorRef,
    gitPanel,
    git,
    paletteOpen,
    paletteItems,
    setPaletteOpen,
    settingsOpen,
    setSettingsOpen,
    newTabOpen,
    creating,
    newTabError,
    setNewTabOpen,
    openExistingWorktree,
    createBranchProject,
    editor,
    saveEditor
  } = props

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
        menuDisabled={settingsOpen || editor !== null}
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
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 8, padding: PANEL_INSET }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 8 }}>
          {view !== 'terminal' && (
            <ErrorBoundary compact>
              <ChatPane
                key={`${project.path}:${chatOwner?.id ?? 'chat'}`}
                pane={chatPane}
                pipelines={pipelines}
                view={view}
                projectPath={project.path}
                defaultProvider={settings.agent}
                defaultModel={settings.models[settings.agent]}
                settings={settings}
                usage={usage}
                onRefreshUsage={onRefreshUsage}
                onMessage={(text, provider, model, mode) =>
                  sendAgentMessage(text, provider, undefined, undefined, model ?? null, mode)
                }
                onAnswer={(requestId, answers) => {
                  if (chatPane) void api.agent.answer(chatPane.taskId, requestId, answers)
                }}
                onCancel={cancelAgent}
                onProviderChange={setAgentProvider}
                onModeChange={setAgentMode}
                onExecutePlan={executePlan}
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
              canSplit={!!active && active.kind === 'shell' && active.panes[active.focus]?.kind === 'shell'}
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
          onEdit={(p) =>
            setEditor({
              id: p.id,
              name: p.name,
              nodes: p.nodes.map((n) => ({ ...n })),
              ...(p.mandatory === true ? { mandatory: true } : {})
            })
          }
          onDelete={deletePipeline}
          onOpenTerminal={openRunLogs}
          collapsed={pipesCollapsed}
          onSetCollapsed={setPipesCollapsed}
        />
      </div>

      <CommandPalette open={paletteOpen} items={paletteItems} onClose={() => setPaletteOpen(false)} />
      {settingsOpen && visible && (
        <SettingsPage
          settings={settings}
          onSettings={(next) => {
            setSettings(next)
            void api.settings.save(next)
          }}
          onOpenRouterSettings={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {newTabOpen && (
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

      {editor && visible && createPortal(
        <div
          className="bf-page-overlay"
          style={{
            position: 'fixed',
            inset: `${CHROME_ROW}px 0 0`,
            zIndex: 80,
            display: 'flex',
            flexDirection: 'column',
            background: '#181817'
          }}
        >
          <PipelineCanvas
            editor={editor}
            settings={settings}
            keyboardEnabled={!settingsOpen}
            onChange={setEditor}
            onCancel={() => setEditor(null)}
            onSave={saveEditor}
          />
        </div>,
        document.body
      )}

      {git.isRepo && (
        <GitPane
          branch={git.branch}
          branches={git.branches}
          remotes={git.remotes ?? []}
          provider={settings.commitMessage.agent}
          model={settings.commitMessage.model}
          settings={settings}
          onCommitMessageModelChange={(provider, model) => {
            const next = withCommitMessageModel(settings, provider, model)
            setSettings(next)
            void api.settings.save(next)
          }}
          {...gitPanel}
          open={gitOpen && visible}
          onClose={() => onGitOpenChange(false)}
          anchorRef={gitAnchorRef}
        />
      )}
    </div>
  )
}

interface ProjectWorkspaceProps {
  project: Project
  visible: boolean
  /** Incremented when the rail asks this project to open the branch dialog. */
  branchDialogNonce: number
  /** Incremented when the rail asks this project to clear its chat. */
  newChatNonce: number
  gitOpen: boolean
  onGitOpenChange: Dispatch<SetStateAction<boolean>>
  gitAnchorRef: RefObject<HTMLButtonElement>
  onGitControlChange: (control: GitControl | null) => void
  onOpenProject: () => void
  onOpenPath: (path: string) => void
  onCloseProject: () => void
  usage: ProviderUsage[]
  onRefreshUsage: () => void
  /** Tell the project rail when this checkout's agent is working. */
  onAgentBusyChange?: (projectPath: string, busy: boolean) => void
  /** Tell the project rail when a finished chat still needs to be opened. */
  onAgentUnreadChange?: (projectPath: string, unread: boolean) => void
}

function ProjectWorkspace({
  project,
  visible,
  branchDialogNonce,
  newChatNonce,
  gitOpen,
  onGitOpenChange,
  gitAnchorRef,
  onGitControlChange,
  onOpenProject,
  onOpenPath,
  onCloseProject,
  usage,
  onRefreshUsage,
  onAgentBusyChange,
  onAgentUnreadChange
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [clearChatConfirm, setClearChatConfirm] = useState(false)
  const [chatClearedNotice, setChatClearedNotice] = useState(false)

  const seq = useRef({ shell: 1, pane: 0, split: 0 })
  const pipelinesRef = useRef<Pipeline[]>([])
  const settingsRef = useRef<AppSettings>(settings)
  const askAiRef = useRef<((prompt: string) => void) | undefined>(undefined)
  const gitPanel = useGitPanel(project.path, () => {
    const { agent, models } = settingsRef.current
    return { agent, model: models[agent] }
  }, {
    enabled: visible && git.isRepo,
    open: gitOpen,
    onHeadChange: setGit,
    onAskAi: (prompt) => askAiRef.current?.(prompt)
  })

  useEffect(() => {
    if (!visible) return
    if (!git.isRepo) {
      onGitControlChange(null)
      return
    }
    onGitControlChange({
      dotColor: gitStatusDotColor(gitPanel.status, gitPanel.github),
      busy: gitPanel.gitAction !== null,
      pulling: gitPanel.gitAction === 'pull',
      pullResult: gitPanel.log.filter((entry) => entry.action === 'Pull').at(-1),
      pull: gitPanel.pull
    })
    return () => onGitControlChange(null)
  }, [visible, git.isRepo, gitPanel.status, gitPanel.github, gitPanel.gitAction, gitPanel.log, gitPanel.pull, onGitControlChange])

  useEffect(() => {
    if (!visible) onGitOpenChange(false)
  }, [visible, onGitOpenChange])
  const sendToAgentRef = useRef<(branch: string, cwd: string) => void>(() => {})
  const worktreeBusy = useRef(false)
  const lastRunOut = useRef<{ paneId: string; nodeId: string } | null>(null)
  /**
   * Per-pipeline generation: Stop / newer Start of the *same* pipeline bumps it so an
   * in-flight cancel→start cannot resurrect that run. Other pipelines keep their own
   * counter so concurrent Starts do not strand each other as permanently `running`.
   */
  const runStartGen = useRef<Record<string, number>>({})
  const activeRunSlots = useRef(new Map<string, { pipelineId: string; runtimeId: string; branch: string }>())
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

  const runBranchForBusy = resolveRunBranch(project, active, git)
  const pipelineBusy = useMemo(() => {
    for (const byBranch of Object.values(runs)) {
      if (byBranch[runBranchForBusy]?.status === 'running') return true
    }
    return false
  }, [runs, runBranchForBusy])

  const worktreeBusyFlag = agentBusy || pipelineBusy
  const wasWorktreeBusy = useRef(false)
  const chatOpen = visible && view !== 'terminal'

  useEffect(() => {
    onAgentBusyChange?.(project.path, worktreeBusyFlag)
    if (worktreeBusyFlag) {
      // Green pulse wins while work is in flight.
      onAgentUnreadChange?.(project.path, false)
    } else if (wasWorktreeBusy.current && !chatOpen) {
      // Finished while the user was elsewhere — leave a blue unread mark.
      onAgentUnreadChange?.(project.path, true)
    }
    wasWorktreeBusy.current = worktreeBusyFlag
    return () => onAgentBusyChange?.(project.path, false)
  }, [worktreeBusyFlag, chatOpen, onAgentBusyChange, onAgentUnreadChange, project.path])

  useEffect(() => {
    if (chatOpen) onAgentUnreadChange?.(project.path, false)
  }, [chatOpen, onAgentUnreadChange, project.path])

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

      const tab = agentChatTab(
        owner,
        project,
        branchForTab(owner, project.path, gitRef.current),
        settingsRef.current
      )
      setTabs((prev) => chatTabFor(prev, owner.id) ? prev : [...prev, tab])
      return { pane: tab.panes[tab.focus] as AgentPane, owner }
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

  /** Interactive coding CLI in a real PTY — OpenRouter key stays on that process only. */
  const newAgentTerminal = useCallback(() => {
    if (!project) return
    const agent = settingsRef.current.agent
    const id = `sh${++seq.current.shell}`
    const paneId = nextPaneId()
    setTabs((prev) => [
      ...prev,
      {
        id,
        kind: 'shell',
        title: AI_LABELS[agent],
        status: null,
        root: leaf(paneId),
        focus: paneId,
        panes: { [paneId]: shellPane(paneId, project.path, agent) }
      }
    ])
    setActiveTab(id)
    showTerminal(id)
  }, [project, showTerminal])

  /** Parallel branch work opens as its own project (separate worktree). */
  const openBranchDialog = useCallback(async () => {
    if (!project) return
    // Refresh at the moment the picker opens. Git state may still be loading
    // after a project switch, and worktrees can be added outside Farol.
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

      await loadGit(project.path)
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
    return api.ui.onSettings(() => setSettingsOpen(true))
  }, [])

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


  // Agents (and other editors) rewrite `.farol/pipelines.json` on disk —
  // pick that up without requiring an app restart.
  useEffect(
    () =>
      api.pipelines.onChanged((changed) => {
        if (normPath(changed.projectPath) !== normPath(project.path)) return
        setPipelines(changed.pipelines)
        setSelId((cur) =>
          cur && changed.pipelines.some((p) => p.id === cur) ? cur : (changed.pipelines[0]?.id ?? null)
        )
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

  const applyAgentEventToPane = useCallback((pane: AgentPane, event: AgentTaskEvent): AgentPane => {
    const projectPath = snapRef.current.project?.path ?? project.path
    return applyAgentEvent(
      pane,
      event,
      (runtimeId) => unscopeLocalPipelineId(projectPath, runtimeId),
      tabsRef.current,
      snapRef.current.project,
      gitRef.current
    )
  }, [project.path])

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
          (event): event is Extract<AgentTaskEvent, { kind: 'pipeline' }> => event.kind === 'pipeline' && !!event.runId?.startsWith('error:')
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
              next = syncAgentPipelineRun(next, event, pipelineId, branch, p.nodes, fmtTime(event.startedAt))
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
              const updated = applyAgentEventToPane(pane, event)
              if (updated !== pane) panes = { ...panes, [pane.id]: updated }
            }
            if (panes === tab.panes) return tab
            touched = true
            return { ...tab, panes }
          })
          return touched ? next : prev
        })
      } catch (error) {
        console.error('[farol] agent event flush failed', error)
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
  }, [applyAgentEventToPane, agentPaneByTaskId])

  const sendAgentMessage = useCallback(
    (
      text: string,
      providerOverride?: AppSettings['agent'],
      ownerOverride?: Tab,
      cwdOverride?: string,
      modelOverride?: string | null,
      modeOverride?: AgentMode
    ) => {
      setChatClearedNotice(false)
      const context = ensureChat(ownerOverride)
      if (!context || !project) return
      const { pane, owner } = context
      const clean = text.trim()
      if (!clean) return
      const provider = providerOverride ?? pane.provider
      const model = modelOverride === null ? undefined : (modelOverride ?? pane.model)
      const requestedMode = modeOverride ?? pane.mode
      const mode = normalizeMode(requestedMode, provider)
      const fallbacks = modeFallbacks(settingsRef.current, mode, provider, model)

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
      const availablePipelines = pipelinesRef.current
        .filter((pipeline) => pipeline.nodes.length)
        .map((pipeline) => ({ ...pipeline, id: managedRuntimePipelineId(pipeline.id) }))
      if (!availablePipelines.length && mode === 'build') {
        failStart('No validation pipelines are configured — Chat cannot start until this project has at least one.')
        return
      }

      const branch = branchForTab(owner, project.path, git)
      const cwd = cwdOverride || pane.cwd
      const startRequest = {
        id: pane.taskId,
        prompt: clean,
        provider,
        ...(model ? { model } : {}),
        mode,
        ...(fallbacks.length ? { fallbacks } : {}),
        pipelines: availablePipelines,
        cwd,
        checkout: owningWorktree(cwd, git.worktrees ?? [])?.path ?? project.path,
        branch
      }
      const runAgent = (operation: 'message' | 'start'): void => {
        if (operation === 'message') {
          // Prefer start when the task is gone (e.g. after a restart).
          // Pass current pipelines so mid-chat edits (AI provider, steps) stick.
          void api.agent
            .message(pane.taskId, clean, provider, availablePipelines, model, mode, fallbacks)
            .then((result) => {
              if (result.ok) return
              runAgent('start')
            })
          return
        }
        void api.agent.start(startRequest).then((result) => {
          if (result.ok) return
          // Still winding down after Stop — queue with the selected provider.
          void api.agent
            .message(pane.taskId, clean, provider, availablePipelines, model, mode, fallbacks)
            .then((queued) => {
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
                ...(model ? { model } : { model: undefined }),
                mode,
                messages: [
                  ...consumePlans(current.messages),
                  {
                    role: 'system',
                    text:
                      mode === 'plan'
                        ? 'Plan mode is read-only.'
                        : `Choosing from ${availablePipelines.length} validation pipeline${availablePipelines.length === 1 ? '' : 's'}.`
                  }
                ]
              }
            : current
        )
        runAgent('start')
        return
      }

      patchPane(pane.id, (current) =>
        current.kind === 'agent'
          ? {
              ...current,
              status: 'working',
              provider,
              model,
              mode,
              messages: consumePlans(current.messages)
            }
          : current
      )
      // Resume the same task so history and the selected provider carry forward.
      runAgent('message')
    },
    [ensureChat, project, git, patchPane]
  )
  askAiRef.current = (prompt) => {
    onGitOpenChange(false)
    setView('chat')
    sendAgentMessage(prompt)
  }

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
    (provider: AppSettings['agent'], model?: string) => {
      setSettings((prev) => {
        const next = { ...withAgentModel(prev, provider, model), agent: provider }
        void api.settings.save(next)
        return next
      })
      if (!chatPane) return
      // Always record the choice on the pane so the next start/message uses it,
      // including when the user switches after a usage/session limit mid-chat.
      const mode = normalizeMode(chatPane.mode, provider)
      patchPane(chatPane.id, (pane) =>
        pane.kind === 'agent' ? { ...pane, provider, model, mode } : pane
      )
      void api.agent.setProvider(chatPane.taskId, provider, model, mode)
    },
    [chatPane, patchPane]
  )

  const setAgentMode = useCallback(
    (mode: AgentMode) => {
      const pane = chatPane ?? ensureChat()?.pane
      if (!pane) return
      // A mode with its own chain configured switches model with the mode;
      // without one, the pane keeps whatever is already selected.
      const head = settingsRef.current.modeDefaults[mode][0]
      const provider = head?.agent ?? pane.provider
      const model = head ? head.model : pane.model
      const next = normalizeMode(mode, provider)
      patchPane(pane.id, (current) =>
        current.kind === 'agent' ? { ...current, mode: next, provider, model } : current
      )
      void api.agent.setProvider(pane.taskId, provider, model, next)
    },
    [chatPane, ensureChat, patchPane]
  )

  const executePlan = useCallback(
    (index: number) => {
      if (!chatPane) return
      const target = chatPane.messages[index]
      if (!target?.plan?.finished || target.plan.consumed) return
      patchPane(chatPane.id, (pane) =>
        pane.kind === 'agent' ? { ...pane, mode: 'build', messages: consumePlans(pane.messages, index) } : pane
      )
      sendAgentMessage('Execute the plan', undefined, undefined, undefined, undefined, 'build')
    },
    [chatPane, patchPane, sendAgentMessage]
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
      setEditor((ed) => (ed?.id === pipelineId ? null : ed))
      setDetailLogs([])
      setTabs((prev) => (prev.some((tab) => tab.id === tabId) ? prev : [...prev, runLogTab(p, pipelineId, branch, cwd)]))
      setActiveTab(tabId)
      setView('terminal')

      const runtimeId = runtimePipelineId(pipelineId)
      const gen = (runStartGen.current[pipelineId] = (runStartGen.current[pipelineId] ?? 0) + 1)
      const settlePending = (status: 'fail' | 'cancelled'): void => {
        setRuns((prev) => {
          const cur = prev[pipelineId]?.[branch]
          if (!cur || cur.runId !== pendingRunId || cur.status !== 'running') return prev
          return {
            ...prev,
            [pipelineId]: {
              ...prev[pipelineId],
              [branch]: {
                ...cur,
                runId: `${status}:${cur.runId}`,
                status,
                label: runOutcomeLabel(status, branch, fmtTime(cur.startedAt))
              }
            }
          }
        })
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId && t.status === 'running' ? { ...t, status } : t))
        )
      }
      // Wait for cancel so a stopped run cannot race start and keep the old session.
      await api.run.cancel(runtimeId)
      // Stop (or a newer Start of *this* pipeline) during the await bumps the gen — do not start.
      if (gen !== runStartGen.current[pipelineId]) {
        settlePending('cancelled')
        return
      }
      try {
        await api.run.start({ ...p, id: runtimeId }, cwd, branch)
      } catch {
        settlePending('fail')
      }
    },
    [project, git, active]
  )

  useEffect(() => {
    const latestRuns = new Map<string, string>()
    const handle = (e: RunEvent): void => {
      const pipelineId = localPipelineId(e.pipelineId)
      const pipeline = pipelinesRef.current.find((p) => p.id === pipelineId)
      if (!pipelineId || !pipeline) return
      const slot = `run:${pipelineId}:${e.branch}`
      if (e.kind === 'start') {
        const bound = latestRuns.get(slot)
        latestRuns.set(slot, bindLatestRunId(bound, e.runId))
        activeRunSlots.current.set(e.runId, { pipelineId, runtimeId: e.pipelineId, branch: e.branch })
        if (bound === e.runId) return
      } else if (e.kind === 'end') {
        activeRunSlots.current.delete(e.runId)
      }
      if (e.kind === 'start' || e.kind === 'end') {
        setTabs((prev) => projectRunChat(prev, e, pipelineId, pipeline.name))
      }
      if (latestRuns.get(slot) !== e.runId) return
      handleRunEvent(e, {
        localPipelineId,
        pipelines: pipelinesRef.current,
        lastRunOut,
        patchPane,
        patchTab,
        pushLog,
        setRuns,
        setTabs,
        setSelId,
        settingsRef,
        tabsRef,
        sendToAgentRef
      })
      if (e.kind === 'end') latestRuns.delete(slot)
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
          console.error('[farol] run event failed', event, error)
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
      handleWorkspaceKeyDown(e, {
        visible,
        newTabOpen,
        editor,
        paletteOpen,
        settingsOpen,
        gitOpen,
        setSettingsOpen,
        activeTab,
        active,
        view,
        termTabs,
        tabsRef,
        newShellTab,
        splitPane,
        closePane,
        closeTab,
        setView,
        setPaletteOpen,
        setActiveTab
      })
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
    settingsOpen,
    gitOpen,
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
    const saved = (id: string): Pipeline => ({
      id,
      name: editor.name.trim(),
      nodes,
      ...(editor.mandatory === true ? { mandatory: true } : {})
    })
    if (editor.id) {
      persist(pipelines.map((p) => (p.id === editor.id ? saved(p.id) : p)))
      setRuns((prev) => {
        const next = { ...prev }
        delete next[editor.id as string]
        return next
      })
      setSelId(editor.id)
    } else {
      const id = `pl${Date.now()}`
      persist([...pipelines, saved(id)])
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
            status: 'cancelled',
            label: runOutcomeLabel('cancelled', b, fmtTime(r.startedAt))
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
        return { ...t, status: 'cancelled' }
      })
    )
    const runtimeIds = new Set([runtimePipelineId(id)])
    for (const slot of activeRunSlots.current.values()) {
      if (slot.pipelineId === id && (branch === undefined || slot.branch === branch)) {
        runtimeIds.add(slot.runtimeId)
      }
    }
    for (const runtimeId of runtimeIds) void api.run.cancel(runtimeId)
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
      stopPipeline(id)
    },
    [pipelines, persist, activeTab, termTabs, stopPipeline]
  )

  const selected = pipelines.find((p) => p.id === selId) ?? null
  const runBranch = resolveRunBranch(project, active, git)

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
        id: 'new-agent-terminal',
        label: 'New agent terminal',
        group: 'Actions',
        detail: AI_LABELS[settings.agent],
        run: () => newAgentTerminal()
      },
      {
        id: 'open-project',
        label: 'Open project…',
        group: 'Actions',
        run: () => onOpenProject()
      },
      {
        id: 'settings',
        label: 'Settings',
        group: 'Actions',
        run: () => setSettingsOpen(true)
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
  }, [pipelines, termTabs, newShellTab, newAgentTerminal, onOpenProject, runPipeline, setSettingsOpen, settings.agent])

  const branchRuns = useMemo(() => {
    const out: Record<string, RunState> = {}
    for (const [pipelineId, byBranch] of Object.entries(runs)) {
      const r = byBranch[runBranch]
      if (r) out[pipelineId] = r
    }
    return out
  }, [runs, runBranch])

  const cwdLabel = displayPath(active?.panes[active.focus]?.cwd ?? project.path, project)

  return (
    <ProjectWorkspaceView
      liquid={liquid}
      project={project}
      visible={visible}
      view={view}
      setView={setView}
      newShellTab={newShellTab}
      recents={recents}
      menuOpen={menuOpen}
      setMenuOpen={setMenuOpen}
      setRecents={setRecents}
      onOpenProject={onOpenProject}
      onOpenPath={onOpenPath}
      onCloseProject={onCloseProject}
      updateVersion={updateVersion}
      settings={settings}
      setSettings={setSettings}
      usage={usage}
      onRefreshUsage={onRefreshUsage}
      chatOwner={chatOwner}
      chatPane={chatPane}
      pipelines={pipelines}
      sendAgentMessage={sendAgentMessage}
      cancelAgent={cancelAgent}
      setAgentProvider={setAgentProvider}
      setAgentMode={setAgentMode}
      executePlan={executePlan}
      showTerminal={showTerminal}
      requestNewChat={requestNewChat}
      clearChatConfirm={clearChatConfirm}
      clearChat={clearChat}
      setClearChatConfirm={setClearChatConfirm}
      chatClearedNotice={chatClearedNotice}
      setChatClearedNotice={setChatClearedNotice}
      composerRef={composerRef}
      termTabs={termTabs}
      active={active}
      runBranch={runBranch}
      cwdLabel={cwdLabel}
      setActiveTab={setActiveTab}
      closeTab={closeTab}
      patchTab={patchTab}
      closePane={closePane}
      splitPane={splitPane}
      branchRuns={branchRuns}
      detailLogs={detailLogs}
      selected={selected}
      setSelId={setSelId}
      setEditor={setEditor}
      runPipeline={runPipeline}
      stopPipeline={stopPipeline}
      deletePipeline={deletePipeline}
      openRunLogs={openRunLogs}
      pipesCollapsed={pipesCollapsed}
      setPipesCollapsed={setPipesCollapsed}
      gitOpen={gitOpen}
      onGitOpenChange={onGitOpenChange}
      gitAnchorRef={gitAnchorRef}
      gitPanel={gitPanel}
      git={git}
      paletteOpen={paletteOpen}
      paletteItems={paletteItems}
      setPaletteOpen={setPaletteOpen}
      settingsOpen={settingsOpen}
      setSettingsOpen={setSettingsOpen}
      newTabOpen={newTabOpen}
      creating={creating}
      newTabError={newTabError}
      setNewTabOpen={setNewTabOpen}
      openExistingWorktree={openExistingWorktree}
      createBranchProject={createBranchProject}
      editor={editor}
      saveEditor={saveEditor}
    />
  )
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [projectsCollapsed, setProjectsCollapsed] = useState(false)
  const [gitOpen, setGitOpen] = useState(false)
  const [gitControl, setGitControl] = useState<GitControl | null>(null)
  const gitAnchorRef = useRef<HTMLButtonElement>(null)
  const [branchDialog, setBranchDialog] = useState<{ path: string; nonce: number }>({
    path: '',
    nonce: 0
  })
  const [chatRequest, setChatRequest] = useState<{ path: string; nonce: number }>({
    path: '',
    nonce: 0
  })
  const [agentBusyPaths, setAgentBusyPaths] = useState<ReadonlySet<string>>(() => new Set())
  const [agentUnreadPaths, setAgentUnreadPaths] = useState<ReadonlySet<string>>(() => new Set())
  const hydrated = useRef(false)
  const { usage, refresh: refreshUsage } = useUsage()

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

  const setAgentUnread = useCallback((projectPath: string, unread: boolean) => {
    setAgentUnreadPaths((prev) => {
      const has = prev.has(projectPath)
      if (unread === has) return prev
      const next = new Set(prev)
      if (unread) next.add(projectPath)
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
      setAgentBusy(projectPath, false)
      setAgentUnread(projectPath, false)
      setProjects((prev) => {
        const index = prev.findIndex((item) => item.path === projectPath)
        const next = prev.filter((item) => item.path !== projectPath)
        if (activePath === projectPath) {
          setActivePath(next[Math.min(index, next.length - 1)]?.path ?? null)
        }
        return next
      })
    },
    [activePath, setAgentBusy, setAgentUnread]
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
    setGitOpen(false)
  }, [activePath])

  useEffect(() => {
    if (!gitControl) setGitOpen(false)
  }, [gitControl])

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
          boxSizing: 'border-box',
          background: GRADIENT_BG,
          color: C.text,
          fontFamily: UI
        }}
      >
        <div
          style={{
            height: CHROME_ROW,
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
        boxSizing: 'border-box',
        background: GRADIENT_BG
      }}
    >
      <ProjectRail
        projects={projects}
        activePath={activePath}
        busyPaths={agentBusyPaths}
        unreadPaths={agentUnreadPaths}
        onSelect={setActivePath}
        onClose={closeProject}
        onNewBranch={requestBranchDialog}
        onNewChat={requestNewChat}
        collapsed={projectsCollapsed}
        onSetCollapsed={setProjectsCollapsed}
        gitAnchorRef={gitAnchorRef}
        showGit={!!gitControl}
        gitOpen={gitOpen}
        gitDotColor={gitControl?.dotColor}
        onGitToggle={() => setGitOpen((open) => !open)}
        gitBusy={gitControl?.busy}
        gitPulling={gitControl?.pulling}
        gitPullResult={gitControl?.pullResult}
        onGitPull={gitControl?.pull}
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
                gitOpen={gitOpen}
                onGitOpenChange={setGitOpen}
                gitAnchorRef={gitAnchorRef}
                onGitControlChange={setGitControl}
                onOpenProject={openProject}
                onOpenPath={(path) => void openPath(path)}
                onCloseProject={() => closeProject(project.path)}
                usage={usage}
                onRefreshUsage={refreshUsage}
                onAgentBusyChange={setAgentBusy}
                onAgentUnreadChange={setAgentUnread}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
