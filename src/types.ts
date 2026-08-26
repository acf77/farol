import type { AgentTaskStatus, AiProvider, PipelineNode, StepState } from '@shared/types'
import type { TermState } from './ansi'
import type { PaneNode } from './layout'

interface BasePane {
  id: string
  title: string
  /** Working directory — shown in the pane's title bar. */
  cwd: string
}

/** A real terminal: xterm.js in the renderer, an interactive shell behind it. */
export interface ShellPane extends BasePane {
  kind: 'shell'
}

/** A pipeline run's log, rendered by BuildFlow rather than emulated. */
export interface RunPane extends BasePane {
  kind: 'run'
  term: TermState
}

/** A pipeline-run system message renders as a tool card instead of plain text. */
export interface AgentPipelineCard {
  pipelineId: string
  pipelineName: string
  status: 'running' | 'passed' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  /** Tab id of the run this card reports on — jumped to via "Open in terminal". */
  tabId: string
}

/** A tool the agent called, rendered as a compact card in the transcript. */
export interface AgentToolCard {
  /** Stable across the call's start and finish, so one card updates in place. */
  toolId: string
  name: string
  detail?: string
  state: 'running' | 'done' | 'error'
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system'
  text: string
  pipeline?: AgentPipelineCard
  tool?: AgentToolCard
  /**
   * Epoch ms, shown under user bubbles. Render-only — the session sanitizer
   * rebuilds messages as `{role, text}`, so this does not survive a restart.
   */
  at?: number
}

export interface AgentPane extends BasePane {
  kind: 'agent'
  taskId: string
  status: AgentTaskStatus | 'idle'
  attempt: number
  provider: AiProvider
  messages: AgentMessage[]
}

export type Pane = ShellPane | RunPane | AgentPane

export interface Tab {
  id: string
  kind: 'shell' | 'run' | 'agent'
  title: string
  status: null | 'running' | 'pass' | 'fail'
  /** Agent tabs are hidden conversations owned by one shell/worktree tab. */
  ownerTabId?: string
  /** Run tabs: the branch the run started on. Shell tabs: a worktree's branch. */
  branch?: string
  /** Split layout — leaves are pane ids. */
  root: PaneNode
  /** Pane that takes keyboard input. */
  focus: string
  panes: Record<string, Pane>
}

export interface RunState {
  runId: string
  status: 'running' | 'pass' | 'fail'
  label: string
  /** Epoch ms when the run started. */
  startedAt: number
  stepResults: Record<string, StepState>
}

/** Runs are tracked per pipeline, then per branch. */
export type RunsByBranch = Record<string, Record<string, RunState>>

/**
 * Which surfaces are on screen. `split` is the spec's own split — chat beside
 * terminal at 58/42 — not a split within a terminal tab.
 */
export type View = 'chat' | 'terminal' | 'split'

/** One line in the pipelines rail's live log block. */
export interface DetailLog {
  /** Wall-clock stamp, `HH:MM:SS`. */
  t: string
  text: string
  color: string
}

export interface EditorState {
  /** null when creating a new pipeline. */
  id: string | null
  name: string
  nodes: PipelineNode[]
}
