/** The benchmark's vocabulary: subjects, cases, traces and graded results. */

import type { AgentEffort, AiProvider } from '../shared/ai'
import type { GitAction } from '../shared/git-action'
import type { Todo } from '../shared/todos'

/**
 * How Farol hands the agent its tools.
 * - `chat`: Farol's managed Chat. The real `AgentController` builds the prompt, runs the agent's
 *   CLI, reads its `FAROL_*` control lines, runs pipelines, repairs, and performs Git actions.
 * - `mcp`: the agent's CLI on its own, as in a terminal, with Farol's MCP server
 *   (`list_pipelines`, `run_pipeline`, `git_*`) and no Farol prompt. Claude only, for now.
 */
export type Surface = 'chat' | 'mcp'

/** What is benchmarked: a surface, an agent CLI (the harness), and the model it runs. */
export interface Subject {
  surface: Surface
  provider: AiProvider
  model?: string
  effort?: AgentEffort
  /** `chat/claude:claude-opus-5-5`, as given on the command line. */
  label: string
}

export type Category = 'pipelines' | 'git' | 'todos' | 'protocol' | 'outcome'

/** What a scripted agent does in one attempt: edit files (already done), use tools, then say `text`. */
export interface ScriptedTurn {
  text: string
  tools?: { name: string; detail?: string }[]
}

/** A correct agent for a case, used to prove the case is solvable and its checks are right. */
export type Reference = (turn: { repo: string; attempt: number; prompt: string }) => string | ScriptedTurn

export interface BenchCase {
  /** `group/name`, e.g. `pipelines/bugfix`. */
  id: string
  /** What the case is mostly about; checks carry their own categories. */
  category: Exclude<Category, 'protocol' | 'outcome'>
  title: string
  /** The user's message. */
  prompt: string
  mode?: 'build' | 'plan'
  /** Files that differ from the fixture; `null` deletes one. */
  files?: Record<string, string | null>
  /** Bare ids from `FIXTURE_PIPELINES` offered to the agent; defaults to `DEFAULT_PIPELINES`. */
  pipelines?: string[]
  /** Farol's Git actions on, the branch the checkout is on, and executable `.git/hooks` scripts. */
  git?: { enabled?: boolean; branch?: string; hooks?: Partial<Record<'pre-commit' | 'pre-push', string>> }
  /** The checkout's todo list when the chat starts. */
  todos?: Todo[]
  maxAttempts?: number
  /** Graded on the `chat` surface. Protocol and outcome checks are added for every case. */
  checks: Check[]
  /** Graded on the `mcp` surface; a case without them is not run there. */
  mcpChecks?: Check[]
  /** Commands run in the final working tree; each must exit 0 for the task to count as done. */
  acceptance?: { name: string; cmd: string }[]
  /** Whether the agent should change files at all. */
  changesFiles: boolean
  reference: Reference
}

/** Why Farol sent the agent another attempt, read from that attempt's prompt. */
export type RetryReason =
  | 'validation-failed'
  | 'git-hook-blocked'
  | 'invalid-pipeline-selection'
  | 'self-ran-pipeline'
  | 'skipped-mandatory'
  | 'invalid-questions'
  | 'invalid-git-line'
  | 'plan-marker'
  | 'user'
  | 'other'

/** Retries that mean the agent broke Farol's control-line protocol, not that its code failed. */
export const PROTOCOL_RETRIES: readonly RetryReason[] = [
  'invalid-pipeline-selection',
  'invalid-questions',
  'invalid-git-line',
  'plan-marker'
]

export interface ToolCall {
  name: string
  detail?: string
  state: 'running' | 'done' | 'error'
}

/** One run of the agent's CLI. */
export interface AttemptTrace {
  index: number
  /** What Farol sent, so a failure can be read in full. */
  prompt: string
  /** Why this attempt happened; undefined for the first. */
  reason?: RetryReason
  /** Everything the agent said. */
  text: string
  /** Finished tool calls. */
  tools: ToolCall[]
  exitCode: number
  durationMs: number
  /** Paths the attempt changed in the working copy. */
  changedFiles: string[]
  /** Bare ids it selected with `FAROL_PIPELINES`; null when it sent no readable selection. */
  selection: string[] | null
}

export interface PipelineRunTrace {
  /** Bare id. */
  id: string
  ok: boolean
  /** How many agent attempts had finished when it ran. */
  afterAttempt: number
  via: Surface
  /** The working tree it ran on, to tell whether it saw the agent's final code. */
  tree?: string
  failedOutput?: string
}

export interface GitActionTrace {
  request: GitAction
  ok: boolean
  message: string
  hookBlocked: boolean
  afterAttempt: number
  via: Surface
}

export interface Usage {
  costUsd?: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  sessions: string[]
}

export type FinalStatus = 'completed' | 'needs-attention' | 'failed' | 'asking' | 'cancelled' | 'timeout' | 'error'

export interface Trace {
  caseId: string
  subject: string
  trial: number
  surface: Surface
  status: FinalStatus
  statusMessage: string
  attempts: AttemptTrace[]
  pipelineRuns: PipelineRunTrace[]
  gitActions: GitActionTrace[]
  /** Every list the agent saved, in order. */
  todoSaves: Todo[][]
  todosBefore: Todo[]
  todosAfter: Todo[]
  questionsAsked: number
  /** Paths the agent changed, across attempts (pipelines' own writes excluded). */
  agentChangedFiles: string[]
  /** The working tree when the agent last finished. */
  finalTree?: string
  acceptance: { name: string; ok: boolean; output: string }[]
  /** Bare ids of the pipelines offered, and their shell commands. */
  catalog: { id: string; cmds: string[] }[]
  usage: Usage
  durationMs: number
  error?: string
}

export interface CheckResult {
  pass: boolean
  detail?: string
}

export interface Check {
  id: string
  category: Category
  /** A case passes only when every critical check passes. */
  critical: boolean
  description: string
  grade(trace: Trace): CheckResult
}

export interface GradedCheck {
  id: string
  category: Category
  critical: boolean
  description: string
  pass: boolean
  detail?: string
}

export interface CaseResult {
  caseId: string
  subject: string
  trial: number
  pass: boolean
  /** Every check passed, critical or not. */
  strict: boolean
  /** The agent's CLI never ran (not signed in, model unavailable, usage limit): not scored. */
  cliError?: string
  checks: GradedCheck[]
  trace: Trace
}
