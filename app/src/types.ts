import type {
  AgentMode,
  AgentQuestion,
  AgentTaskStatus,
  AiProvider,
  GitHookEvent,
  PipelineNode,
  PipelineTarget,
  StepState
} from '@shared/types'
import type { ContextUsage, SavedAgentContext } from '@shared/agent-context'
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
  /** Dedicated interactive AI CLI — PTY runs that binary with its env, not a login shell. */
  agent?: AiProvider
}

/** A pipeline run's log, rendered by Farol rather than emulated. */
export interface RunPane extends BasePane {
  kind: 'run'
  term: TermState
}

/** A pipeline-run system message renders as a tool card instead of plain text. */
export interface AgentPipelineCard {
  runId?: string
  pipelineId: string
  pipelineName: string
  status: 'running' | 'passed' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  /** Tab id of the run this card reports on — jumped to via "Open in terminal". */
  tabId: string
}

/** Questions the agent asked; stays interactive until the user answers. */
export interface AgentQuestionCard {
  requestId: string
  questions: AgentQuestion[]
  answers?: string[][]
  dismissed?: boolean
}

/** A tool the agent called, rendered as a compact card in the transcript. */
export interface AgentToolCard {
  /** Stable across the call's start and finish, so one card updates in place. */
  toolId: string
  name: string
  detail?: string
  state: 'running' | 'done' | 'error'
}

/** A subagent run from the agent's `delegate` call, with what it is doing folded in. */
export interface AgentDelegateCard {
  delegateId: string
  provider: AiProvider
  model?: string
  task: string
  state: 'running' | 'done' | 'error'
  diffStat?: string
  message?: string
  /** The subagent's own tool calls, latest last. */
  tools: AgentToolCard[]
  /** What the subagent last said. */
  said: string
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system'
  text: string
  pipeline?: AgentPipelineCard
  tool?: AgentToolCard
  delegate?: AgentDelegateCard
  question?: AgentQuestionCard
  /**
   * Epoch ms, shown under user bubbles. Render-only — the session sanitizer
   * rebuilds messages as `{role, text}`, so this does not survive a restart.
   */
  at?: number
  /** A completed Plan response, optionally invalidated or executed. */
  plan?: { finished: true; consumed?: true }
}

export interface AgentPane extends BasePane {
  kind: 'agent'
  taskId: string
  status: AgentTaskStatus | 'idle'
  attempt: number
  provider: AiProvider
  mode: AgentMode
  /** Model id for `provider`. Omitted uses the CLI's own default. */
  model?: string
  messages: AgentMessage[]
  /** The agent's handoff note and CLI session, so the chat continues after a restart. */
  context?: SavedAgentContext
  /** How full the agent's context was at its latest model call. Not saved. */
  usage?: ContextUsage
}

export type Pane = ShellPane | RunPane | AgentPane

export interface Tab {
  id: string
  kind: 'shell' | 'run' | 'agent'
  title: string
  status: null | 'running' | 'pass' | 'fail' | 'cancelled'
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
  status: 'running' | 'pass' | 'fail' | 'cancelled'
  label: string
  /** Epoch ms when the run started. */
  startedAt: number
  stepResults: Record<string, StepState>
}

/** Runs are tracked per pipeline, then per branch. */
export type RunsByBranch = Record<string, Record<string, RunState>>

/** The toolbar's layout presets. `split` is chat beside terminal — not a split within a terminal tab. */
export type View = 'chat' | 'code' | 'terminal' | 'split'

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
  mandatory?: boolean
  /** When true, Jev may auto-add this pipeline in Chat. */
  autoSelectable?: boolean
  /** `remote` runs shell steps on the Farol service. */
  target?: PipelineTarget
  /** With a `remote` target: run locally when the sandbox cannot start. */
  fallbackLocal?: boolean
  /** Git hook events that run this pipeline; see `Pipeline['gitHooks']`. */
  gitHooks?: GitHookEvent[]
}
