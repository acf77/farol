/** Types shared between the main process, the preload bridge, and the renderer. */

import type { AiProvider } from './ai'
import type { AgentQuestion } from './questions'
import type { ProjectSession } from './session'
import type { AgentSkill } from './skills'
import type { WorktreeRequest } from './worktree'
import type { AppSettings } from './settings'

export type { AgentQuestion, AgentSkill }

export type { AiProvider, AppSettings, ProjectSession, WorktreeRequest }
export { aiFixCommand } from './ai'
export { FAILURE_REPORT_REL } from './failure'
export { parseVerdict, VERDICT_MARKER, verdictPromptSuffix } from './verdict'
export { defaultSettings, sanitizeSettings } from './settings'
export {
  AI_LABELS,
  AI_MODELS,
  AI_PROVIDERS,
  aiSelectionLabel,
  normalizeAi,
  normalizeModel
} from './ai'

export interface Project {
  name: string
  /** Absolute path on disk. */
  path: string
  /** Home-relative display path, e.g. `~/dev/farol`. */
  display: string
}

export type StepType = 'shell' | 'ai'

export interface Step {
  name: string
  type: StepType
  /** Shell command for `shell` steps, prompt text for `ai` steps. */
  cmd: string
  /** Which CLI to invoke for `ai` steps. Omitted AI steps run Claude. */
  ai?: AiProvider
  /** Model id for that CLI. Omitted AI steps use the CLI's own default. */
  model?: string
}

/** One node on the pipeline canvas. `after` is the parent ids to wait on. */
export interface PipelineNode extends Step {
  id: string
  after: string[]
  /**
   * When true, a failure skips descendants. Defaults to true for shell, false
   * for AI — reviews can fail without blocking Summarize.
   */
  gate?: boolean
  x: number
  y: number
}

export interface Pipeline {
  id: string
  name: string
  nodes: PipelineNode[]
  /** When true, managed Chat always runs this pipeline after code-changing turns. */
  mandatory?: boolean
}

export type StepState = 'pending' | 'running' | 'pass' | 'fail' | 'skip'

export interface GitInfo {
  isRepo: boolean
  /** Branch name, or the short sha when HEAD is detached. */
  branch: string
  branches: string[]
  /** Remote-tracking branches with no local counterpart, e.g. `origin/staging`. */
  remotes?: string[]
  detached?: boolean
  /** True when this path is a bare hub — open worktrees as projects instead of checking out. */
  bare?: boolean
  /** Other checkouts of this repo — closing a tab does not remove these. */
  worktrees?: { path: string; branch: string }[]
}

export interface GitChanged {
  projectPath: string
  info: GitInfo
}

export type GitFileKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict'

export interface GitStatusFile {
  path: string
  kind: GitFileKind
  staged: boolean
}

export interface GitStatus {
  clean: boolean
  staged: GitStatusFile[]
  unstaged: GitStatusFile[]
  untracked: GitStatusFile[]
  conflicts: GitStatusFile[]
  ahead: number
  behind: number
}

export interface GitCommit {
  hash: string
  subject: string
  author: string
  when: string
}


export interface PullRequest {
  number: number
  title: string
  url: string
  headRef: string
  hasConflicts: boolean
  hasChecks: boolean
  checksPending: number
  checksFailed: number
}

export interface GitHubInfo {
  available: boolean
  message?: string
  prs: PullRequest[]
}

/** Fired when `.farol/pipelines.json` changes on disk (including outside the app). */
export interface PipelinesChanged {
  projectPath: string
  pipelines: Pipeline[]
}

export interface OpenProjects {
  paths: string[]
  activePath: string | null
}

/** One styled run of characters within a terminal line. */
export interface Segment {
  text: string
  color?: string
  bold?: boolean
  dim?: boolean
}

/** A shell command finished (or was killed). */
export interface ShellExit {
  tabId: string
  code: number
  signal?: number
  /** Working directory after the command — `cd` persists per tab. */
  cwd: string
  durationMs: number
  /** The shell itself exited (the user ran `exit`), not just one command. */
  sessionEnded?: boolean
}

export interface ShellData {
  tabId: string
  chunk: string
}

/** The shell reported a new working directory (OSC 7). */
export interface ShellCwd {
  paneId: string
  cwd: string
}

/** Who asked for the run. Agent runs must not re-trigger the failure hand-off. */
export type RunOrigin = 'app' | 'agent' | 'managed-agent'

export interface PipelineStepResult {
  nodeId: string
  ok: boolean
  code: number
  skipped?: boolean
  output: string
}

export interface PipelineRunResult {
  runId: string
  pipelineId: string
  ok: boolean
  cancelled?: boolean
  failedNodeId?: string
  reportPath?: string
  steps: PipelineStepResult[]
}

export type AgentTaskStatus =
  | 'working'
  | 'asking'
  | 'validating'
  | 'repairing'
  | 'completed'
  | 'needs-attention'
  | 'cancelled'
  | 'failed'

export interface AgentTaskRequest {
  id: string
  prompt: string
  provider: AiProvider
  /** Model id for `provider`. Omitted uses the CLI's own default. */
  model?: string
  /** Snapshot of every pipeline the agent may select for validation. */
  pipelines: Pipeline[]
  cwd: string
  branch: string
  maxAttempts?: number
}

export type AgentTaskEvent =
  | {
      kind: 'status'
      taskId: string
      status: AgentTaskStatus
      attempt: number
      message: string
    }
  | {
      kind: 'pipeline'
      taskId: string
      pipelineId: string
      pipelineName: string
      status: 'running' | 'passed' | 'failed' | 'cancelled'
      startedAt: number
      finishedAt?: number
      durationMs?: number
      runId?: string
    }
  /** Plain-text stdout, appended to the assistant turn in progress. */
  | { kind: 'output'; taskId: string; chunk: string }
  /** One complete assistant turn from a streaming provider. */
  | { kind: 'assistant'; taskId: string; text: string }
  /** A tool the agent invoked; `toolId` repeats when the call finishes. */
  | {
      kind: 'tool'
      taskId: string
      toolId: string
      name: string
      detail?: string
      state: 'running' | 'done' | 'error'
    }
  | { kind: 'user'; taskId: string; text: string }
  /** Agent asked the user; `answers` is set when they reply or dismiss. */
  | {
      kind: 'question'
      taskId: string
      requestId: string
      questions: AgentQuestion[]
      answers?: string[][]
      dismissed?: boolean
    }

/** Every run event carries the branch the run started on. */
interface RunEventBase {
  runId: string
  pipelineId: string
  branch: string
  origin: RunOrigin
}

export type RunEvent =
  | (RunEventBase & { kind: 'start'; steps: number })
  | (RunEventBase & { kind: 'step-start'; index: number; nodeId: string })
  | (RunEventBase & { kind: 'output'; index: number; nodeId: string; chunk: string })
  | (RunEventBase & {
      kind: 'step-end'
      index: number
      nodeId: string
      ok: boolean
      code: number
      durationMs: number
      cancelled?: boolean
      skipped?: boolean
    })
  | (RunEventBase & {
      kind: 'end'
      ok: boolean
      /** Index of a gated failure, if any. */
      failedAt?: number
      failedNodeId?: string
      cancelled?: boolean
      /** Absolute path to the failure report, written only when a step failed. */
      reportPath?: string
    })

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

export type Platform = 'darwin' | 'win32' | 'linux' | (string & {})

export interface FarolApi {
  platform: Platform
  /** The machine's default shell, e.g. `zsh` — used to label terminal tabs. */
  shellName: string
  project: {
    open(): Promise<Project | null>
    recents(): Promise<Project[]>
    openPath(path: string): Promise<Project | null>
    /** Relative paths under the project root, filtered by an optional query. */
    listFiles(projectPath: string, query?: string): Promise<string[]>
    /** User-invocable skills for the selected agent, from its native scopes. */
    listSkills(projectPath: string, provider: AiProvider): Promise<AgentSkill[]>
    /** Persist a dropped chat image; returns the absolute path on disk. */
    saveAttachment(
      projectPath: string,
      name: string,
      data: ArrayBuffer
    ): Promise<string | null>
    /** Fires when a project is opened from the application menu. */
    onOpened(cb: (p: Project) => void): () => void
  }
  session: {
    last(): Promise<string | null>
    openProjects(): Promise<OpenProjects>
    saveOpenProjects(paths: string[], activePath: string | null): Promise<void>
    load(projectPath: string): Promise<ProjectSession | null>
    save(projectPath: string, session: ProjectSession, last: boolean): Promise<void>
    clearLast(): Promise<void>
  }
  pipelines: {
    load(projectPath: string): Promise<Pipeline[]>
    save(projectPath: string, pipelines: Pipeline[]): Promise<void>
    /** Fires when pipelines.json changes, including from outside the app. */
    onChanged(cb: (changed: PipelinesChanged) => void): () => void
  }
  shell: {
    /** Start an interactive shell for a pane. */
    open(paneId: string, cwd: string, cols?: number, rows?: number): Promise<void>
    /** Keystrokes from xterm, straight through to the PTY. */
    write(paneId: string, data: string): Promise<void>
    resize(paneId: string, cols: number, rows: number): Promise<void>
    dispose(paneId: string): Promise<void>
    /**
     * Like `write`, but held until the PTY exists — so a command aimed at a
     * pane that is still starting up is not silently dropped.
     */
    send(paneId: string, data: string): Promise<void>
    onData(cb: (e: ShellData) => void): () => void
    onExit(cb: (e: ShellExit) => void): () => void
    onCwd(cb: (e: ShellCwd) => void): () => void
  }
  git: {
    info(projectPath: string): Promise<GitInfo>
    checkout(projectPath: string, branch: string): Promise<{ ok: boolean; message: string }>
    /**
     * Create or reuse a worktree for `req.branch` and return its path. The
     * project's current checkout is not switched. `reused` marks a worktree
     * that already existed, so nothing was branched.
     */
    worktree(
      projectPath: string,
      req: WorktreeRequest
    ): Promise<{
      ok: boolean
      path?: string
      branch?: string
      reused?: boolean
      message: string
    }>
    status(projectPath: string): Promise<GitStatus>
    recentCommits(projectPath: string): Promise<GitCommit[]>
    draftCommit(
      projectPath: string,
      provider: AiProvider,
      model?: string
    ): Promise<{
      ok: boolean
      message?: string
      files?: string[]
      skipped?: string[]
      error?: string
    }>
    commit(
      projectPath: string,
      message: string,
      files?: string[]
    ): Promise<{ ok: boolean; message?: string; error?: string }>
    push(projectPath: string): Promise<{ ok: boolean; message: string }>
    github(projectPath: string): Promise<GitHubInfo>
    /** Fires when HEAD changes, including from outside the app. */
    onChanged(cb: (changed: GitChanged) => void): () => void
  }
  run: {
    start(pipeline: Pipeline, cwd: string, branch: string): Promise<string>
    cancel(pipelineId: string): Promise<void>
    onEvent(cb: (e: RunEvent) => void): () => void
  }
  agent: {
    start(request: AgentTaskRequest): Promise<{ ok: boolean; message?: string }>
    message(
      taskId: string,
      text: string,
      provider?: AiProvider,
      pipelines?: Pipeline[],
      model?: string
    ): Promise<{ ok: boolean; message?: string }>
    setProvider(
      taskId: string,
      provider: AiProvider,
      model?: string
    ): Promise<{ ok: boolean; message?: string }>
    cancel(taskId: string): Promise<void>
    /** Cancel and drop the task so cleared chats cannot retain prompt history. */
    dispose(taskId: string): Promise<void>
    /** Reply to an `asking` turn. `answers: null` dismisses the questions. */
    answer(
      taskId: string,
      requestId: string,
      answers: string[][] | null
    ): Promise<{ ok: boolean; message?: string }>
    onEvent(cb: (e: AgentTaskEvent) => void): () => void
  }
  settings: {
    load(): Promise<AppSettings>
    save(settings: AppSettings): Promise<void>
  }
  update: {
    check(): Promise<UpdateStatus>
    install(): void
    onStatus(cb: (s: UpdateStatus) => void): () => void
  }
  /** Native Liquid Glass behind chrome (macOS 26+). */
  ui: {
    glass(): Promise<boolean>
    onGlass(cb: (active: boolean) => void): () => void
  }
  window: {
    minimize(): void
    maximize(): void
    close(): void
  }
}
