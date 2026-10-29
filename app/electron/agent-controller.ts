import { spawn, type ChildProcess } from 'child_process'
import { StringDecoder } from 'string_decoder'
import type {
  AgentTaskEvent,
  AgentTaskRequest,
  AgentTaskStatus,
  AiProvider,
  ApprovalDecision,
  ModelChoice,
  Pipeline,
  PipelineRunResult,
  RevertOutcome,
  TurnInfo
} from '../shared/types'
import {
  ACP_CLIS,
  aiSelectionLabel,
  canAskApproval,
  cliFor,
  isAiProvider,
  isUnknownJsonFormatError,
  managedAiCommand,
  normalizeAi,
  normalizeMode,
  normalizeModel
} from '../shared/ai'
import {
  isDelegateToolName,
  MANAGED_MCP_SERVER_KEY,
  MANAGED_TOOL_TIMEOUT_SEC,
  managedToolsFor,
  type ManagedTool,
  type McpServerEntry
} from '../shared/mcp-config'
import { applyOpencodeConfig, opencodeRunConfig } from '../shared/opencode-config'
import { acpApprovalAsk, acpMcpServer } from '../shared/acp'
import { openCodeModel } from '../shared/openrouter'
import { runAcp } from './acp-run'
import { captureLimited, captureTree, changedPaths, pinTree, releaseTrees, restoreTree, treeDiffStat, undoChange, type Capture } from './delegate-snapshot'
import {
  CHECKPOINT_MAX_FILE_BYTES,
  listTurns,
  previewRevert,
  releaseCheckpoints,
  revertToTurn,
  startTurn,
  turnPreview,
  type TurnRecord
} from './checkpoints'
import { AgentStreamParser } from '../shared/agent-stream'
import { claudeCatalogWindow } from '../shared/agent-models'
import {
  FRESH_START_KEEP_FOLLOW_UPS,
  HANDOFF_MARKER,
  MAX_HANDOFF_CHARS,
  addFollowUp,
  knownContextWindow,
  historyText,
  newAgentContext,
  parseHandoffMarker,
  resumableSession,
  sanitizeAgentContext,
  type AgentContext,
  type ContextUsage
} from '../shared/agent-context'
import {
  appendControlLines,
  flushControlLines,
  lastControlLine,
  stripControlMarkerLines,
  type ControlLineState
} from '../shared/control-line'
import {
  BLOCK_MARKER,
  FINISHED_PLAN,
  PIPELINES_MARKER,
  QUESTIONS_MARKER,
  formatAnswers,
  isFinishedPlan,
  parseQuestionsMarker,
  validateAnswers,
  type AgentQuestion
} from '../shared/questions'
import {
  catalogShellCommands,
  isShellToolName,
  matchedCatalogShells,
  pipelinesForCatalogCmds
} from '../shared/catalog-shell'
import {
  TODOS_MARKER,
  formatTodos,
  parseTodosMarker,
  todoSummary,
  type Todo,
  type TodoStore
} from '../shared/todos'
import type { CustomPromptStore } from './custom-prompts'
import {
  isWriteToolName,
  mandatoryOptOutError,
  mandatoryPipelines,
  mergeWithMandatory,
  turnChangedFiles
} from '../shared/mandatory'
import { errorMessage, pipelineSelectionState } from '../shared/jev'
import {
  defaultPlanSelection,
  observeToolUse,
  toolPolicyFor,
  toolPolicyPrompt,
  toolSelectionState,
  type ToolPolicy,
  type ToolSelection
} from '../shared/tool-policy'
import { gitSummary } from '../shared/git-step'
import { plainText } from '../shared/terminal'
import { aiEnv, resolveBinFrom } from './bin'
import { openRouterAgent } from './openrouter-agent'
import { backoffWait } from './backoff'
import { killPidTree } from './kill'
import { logAgentFailure } from './agent-failure-log'
import { logJev } from './jev-log'
import { selectPipelines, selectTools } from './jev'

interface ValidationRunner {
  run(
    pipeline: Pipeline,
    cwd: string,
    branch: string,
    origin: 'managed-agent',
    signal?: AbortSignal
  ): Promise<PipelineRunResult>
}

export type AgentToolReport = {
  toolId: string
  name: string
  detail?: string
  state: 'running' | 'done' | 'error'
}

/** Resume a CLI's saved conversation, and learn the id of the one a run used. */
export interface AgentSessionIo {
  resume?: string
  onSession(id: string): void
  /** The latest context reading, as the run reports it. */
  onUsage?(usage: ContextUsage): void
}

export type AgentExecutor = (
  request: AgentTaskRequest,
  prompt: string,
  onOutput: (chunk: string) => void,
  onTool?: (event: AgentToolReport) => void,
  session?: AgentSessionIo
) => Promise<number>

/**
 * Where one agent invocation reports what it is doing. `text` and `turn` both
 * reach the chat and both count as the agent "speaking" — only they are
 * scanned for Farol's markers. `noise` is diagnostics (stderr, banners):
 * held back from the transcript, but still watched for provider failures.
 */
interface AgentSink {
  /** Streaming prose, appended to the turn in progress. */
  text(chunk: string): void
  /** A complete assistant turn. */
  turn(text: string): void
  tool(event: { toolId: string; name: string; detail?: string; state: 'running' | 'done' | 'error' }): void
  question(questions: AgentQuestion[]): void
  noise(chunk: string): void
}

interface Task {
  request: AgentTaskRequest
  process: ChildProcess | null
  /** The subagent a `delegate` call is running; at most one, while the agent waits on it. */
  child: ChildProcess | null
  delegating: boolean
  delegateSeq: number
  /** The agent's latest `delegate` tool call, so its subagent's card can sit under it. */
  delegateToolId?: string
  /** The attempt in flight, so a subagent's file writes count as this turn's. */
  activeScan?: CycleScan
  /** Subagent runs that changed files, kept so Undo can reverse exactly them. */
  delegateRuns: Map<string, DelegateRun>
  /** The tree at the start of the turn, handed to its first attempt so it is not captured twice. */
  turnBefore?: string
  /** What the agent should hear first on the next turn (e.g. an Undo). */
  notes: string[]
  /** The subagent running now, so its approval requests name it. */
  activeDelegate?: { id: string; provider: AiProvider }
  /** Approval requests waiting on the developer, by request id. */
  approvals: Map<string, PendingApproval>
  approvalSeq: number
  /** Tools the developer allowed for the rest of this chat. */
  allowedTools: Set<string>
  /** Whether the agent's run in flight approves tools without asking; fixed when the run starts. */
  runAutoApproves: boolean
  /** Ask-first Codex runs in flight, by `PARENT_GATE` or the subagent's delegate id. */
  gates: Map<string, Gate>
  running: boolean
  cancelled: boolean
  /** Drop from the map once the in-flight cycle settles (cleared chats). */
  disposeWhenIdle: boolean
  guidance: string[]
  pipelineRuns: PipelineActivity[]
  todos: Todo[]
  /** The `<custom_instructions>` block, re-read every attempt; never stored in the chat. */
  customInstructions: string
  /** The chat so far, and the CLI session that already holds it. */
  context: AgentContext
  /** A failed resume already fell back to a new session this cycle. */
  resumeAbandoned: boolean
  /** Last context reading sent to the renderer. */
  usage?: ContextUsage
  abort: AbortController
  /** Set on file writes / failed mandatory runs; cleared when they pass. */
  mandatoryOutstanding: boolean
  /** Rungs of the mode's chain not yet tried; refilled when a turn begins. */
  fallbacks: ModelChoice[]
  /**
   * Consecutive provider-side failures (rate limit, exit code, ...) on the
   * current provider/model. Reset on success or whenever the provider
   * changes; drives same-model retries before `fallbacks` is consulted.
   */
  sameModelAttempts: number
  /**
   * Jev's tool-focus selection for the current attempt. Remapped onto each
   * provider via `toolPolicyFor` (which re-checks the prepared focus set)
   * without a new Jev call; cleared when the attempt number advances
   * (repair turns re-ask).
   */
  toolSelection?: ToolSelection
  toolSelectionAttempt?: number
  /** Bumped when a follow-up starts so a dying cycle cannot clobber it. */
  askEpoch: number
  questionSeq: number
  todoSeq: number
  pendingQuestions?: { requestId: string; questions: AgentQuestion[] }
}

interface PipelineActivity {
  pipelineId: string
  pipelineName: string
  status: 'running' | 'passed' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  runId?: string
}

type CycleScan = ControlLineState & {
  /** This run continued the CLI's saved conversation instead of starting one. */
  resumed: boolean
  assistant: string
  output: string
  /** Diagnostics from the CLI (stderr, banners) only — never the agent's own words. */
  noise: string
  blocked: string | null
  /** The stop came from the CLI itself (quota, auth, context), not the agent. */
  blockedByProvider: boolean
  shellInvocations: string[]
  filesChanged: boolean
  /** Paths or targets reported by completed write tools this turn. */
  changedTargets: string[]
  /** Tool card names observed this turn — for policy violation diagnostics. */
  toolNames: string[]
  questions?: AgentQuestion[]
  questionId?: string
}

/**
 * What a turn asks the agent to do. A `continued` opening builds on earlier
 * turns: a resumed CLI session already holds them; any other run gets the
 * rebuilt history (`historyText`) and handoff note in front of it.
 */
interface Opening {
  text: string
  continued: boolean
}

function continued(text: string): Opening {
  return { text, continued: true }
}

type CycleAttemptResult =
  | { kind: 'done' }
  | { kind: 'retry'; opening: Opening; rewindAttempt?: boolean }

const DEFAULT_MAX_ATTEMPTS = 5
/**
 * Extra tries on the same provider/model after an error before Farol steps
 * down the fallback chain. A rate limit or a flaky exit often clears on its
 * own — falling back on the first hiccup burned through every fallback rung
 * on transient errors, leaving chats "needs-attention" too early.
 */
const SAME_MODEL_RETRIES = 3
/** How much trailing output the marker and failure scans keep in memory. */
const SCAN_WINDOW = 16_384
/** Cap pipeline activity retained for prompt context. */
const MAX_PIPELINE_RUNS = 40

function shouldRetryPlainOpenCode(
  plain: boolean,
  exit: number,
  provider: AiProvider,
  diagnostics: string
): boolean {
  return (
    !plain &&
    exit !== 0 &&
    cliFor(provider, openRouterAgent()) === 'opencode' &&
    isUnknownJsonFormatError(diagnostics)
  )
}

/**
 * Give agents an explicit marker for task-ending blockers. Scanned over what
 * the agent said, never over tool output — a grep that happens to print the
 * marker must not end the task.
 */
function blockedMarker(assistant: string): string | null {
  const marker = assistant.lastIndexOf(BLOCK_MARKER)
  if (marker < 0) return null
  const reason = assistant
    .slice(marker + BLOCK_MARKER.length)
    .split(/\r?\n/, 1)[0]
    .trim()
  return reason || 'The agent reported that it is blocked.'
}

import { providerFailure } from '../shared/provider-failure'

function failureContext(pipeline: Pipeline, result: PipelineRunResult): string {
  const failed = result.steps.filter((step) => !step.ok && !step.skipped)
  const detail = failed
    .map((step) => {
      const output = step.output.trim()
      return `Step ${step.nodeId} exited ${step.code}.${output ? `\n${output}` : ''}`
    })
    .join('\n\n')
  return `${pipeline.name} failed.${detail ? `\n${detail}` : ''}`
}

function repairPromptOpening(
  attempt: number,
  failures: { pipeline: Pipeline; result: PipelineRunResult }[],
  guidance: string
): string {
  return [
    `Farol validation attempt ${attempt} failed. Fix the code, then finish so Farol can validate again.`,
    `Do not re-run the failing shell commands yourself. Follow the failure report's Verify section: select the same pipelines again via ${PIPELINES_MARKER} so Farol re-runs them.`,
    ...failures.flatMap(({ pipeline, result }) => [
      result.reportPath ? `Read the full failure report at ${result.reportPath}.` : '',
      failureContext(pipeline, result)
    ]),
    guidance ? `Additional user guidance:\n${guidance}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
}

function activityStatus(result: PipelineRunResult): PipelineActivity['status'] {
  if (result.cancelled) return 'cancelled'
  return result.ok ? 'passed' : 'failed'
}

/**
 * When the agent shelled catalog step cmds itself, it must still select the
 * pipelines that own those cmds. Opting out with [] after a private `npm test`
 * is how Codex skips Farol validation.
 */
function catalogShellBypassError(
  shellInvocations: string[],
  available: Pipeline[],
  selected: Pipeline[]
): string | undefined {
  const catalog = catalogShellCommands(available)
  const matched = matchedCatalogShells(shellInvocations, catalog)
  if (!matched.length) return undefined
  const required = pipelinesForCatalogCmds(available, matched)
  if (!required.length) return undefined
  const selectedIds = new Set(selected.map((pipeline) => pipeline.id))
  const missing = required.filter((pipeline) => !selectedIds.has(pipeline.id))
  if (!missing.length) return undefined
  const cmds = matched.map((cmd) => `\`${cmd}\``).join(', ')
  const ids = missing.map((pipeline) => pipeline.id)
  return (
    `You ran catalog shell command(s) yourself (${cmds}). ` +
    `Do not do that — select the owning pipeline(s) via ${PIPELINES_MARKER} ${JSON.stringify(ids)} ` +
    `and let Farol execute them.`
  )
}

function parsePipelineIds(output: string): { ids: string[] } | { error: string } {
  const raw = lastControlLine(output, PIPELINES_MARKER)
  if (raw === undefined) {
    return { error: `End your response with ${PIPELINES_MARKER} followed by a JSON array of pipeline ids.` }
  }
  try {
    const ids = JSON.parse(raw) as unknown
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      return { error: `The value after ${PIPELINES_MARKER} must be a JSON array of pipeline id strings.` }
    }
    return { ids }
  } catch {
    return { error: `The value after ${PIPELINES_MARKER} must be a JSON array.` }
  }
}

function selectedPipelines(
  output: string,
  available: Pipeline[]
): { pipelines: Pipeline[]; error?: string } {
  const parsed = parsePipelineIds(output)
  if ('error' in parsed) return { pipelines: [], error: parsed.error }
  // An empty array means the agent made no file changes and wants to skip
  // validation — that is intentional, not a parse error.
  if (!parsed.ids.length) return { pipelines: [] }

  const byId = new Map(available.map((pipeline) => [pipeline.id, pipeline]))
  const selected: Pipeline[] = []
  const unknown: string[] = []
  for (const id of parsed.ids) {
    const pipeline = byId.get(id)
    if (!pipeline) unknown.push(id)
    else if (!selected.includes(pipeline)) selected.push(pipeline)
  }
  if (unknown.length) {
    return { pipelines: [], error: `Unknown pipeline id${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}` }
  }
  return { pipelines: selected }
}

function pipelineCatalog(pipelines: Pipeline[]): string {
  return pipelines
    .map((pipeline) => {
      const tag =
        (pipeline.mandatory ? ' [mandatory]' : '') +
        (pipeline.target === 'remote' ? ' [remote]' : '')
      const steps = pipeline.nodes
        .map((node) => {
          const model = normalizeModel(node.model)
          const kind =
            node.type === 'ai'
              ? `ai/${normalizeAi(node.ai)}${model ? `/${model}` : ''}`
              : node.type
          return `  - ${node.name || node.id} (${kind}): ${node.type === 'git' ? gitSummary(node) : node.cmd}`
        })
        .join('\n')
      return `- ${pipeline.name} [id: ${pipeline.id}]${tag}\n${steps}`
    })
    .join('\n')
}

/** The optional parts of an agent command, present only when set. */
function commandExtras(
  opts: { tools?: string[]; webSearch?: boolean; session?: AgentSessionIo } | undefined,
  extra: { mcp?: McpServerEntry; askApproval: boolean; codexHook?: string }
) {
  const { mcp, askApproval, codexHook } = extra
  return {
    ...(opts?.tools?.length ? { tools: opts.tools } : {}),
    ...(opts?.webSearch ? { webSearch: true } : {}),
    ...(opts?.session?.resume ? { resume: opts.session.resume } : {}),
    ...(mcp ? { mcp } : {}),
    ...(askApproval && mcp ? { askApproval } : {}),
    ...(codexHook ? { codexHook } : {})
  }
}

/** Turns an agent's stream events into chat output, reporting context use when it changes. */
function streamConsumer(
  parser: AgentStreamParser | null,
  sink: AgentSink,
  onUsage: ((usage: ContextUsage) => void) | undefined
): (events: ReturnType<AgentStreamParser['push']>) => void {
  let reported: ContextUsage | undefined
  return (events) => {
    if (parser?.contextTokens) {
      const usage = { tokens: parser.contextTokens, ...(parser.contextWindow ? { window: parser.contextWindow } : {}) }
      if (reported?.tokens !== usage.tokens || reported.window !== usage.window) {
        reported = usage
        onUsage?.(usage)
      }
    }
    for (const event of events) {
      if (event.kind === 'text') sink.turn(event.text)
      else if (event.kind === 'raw') sink.text(plainText(event.text))
      else if (event.kind === 'question') sink.question(event.questions)
      else sink.tool(event)
    }
  }
}

/** Why a subagent run did not succeed, or undefined when it did. */
function delegateFailure(
  label: string,
  run: { stopped: boolean; failed: boolean; code: number; diagnostics: string }
): string | undefined {
  if (run.stopped) return 'Stopped before it finished.'
  if (!run.failed) return undefined
  const tail = run.diagnostics.trim().slice(-2000)
  return `${label} exited with code ${run.code}.${tail ? `\n${tail}` : ''}`
}

/** Files changed since `before`, as a diffstat; empty when the tree could not be read. */
async function treeChanges(
  cwd: string,
  before: string | undefined
): Promise<{ after?: string; diffStat: string }> {
  const after = before ? await captureTree(cwd).catch(() => undefined) : undefined
  const diffStat = before && after ? await treeDiffStat(cwd, before, after).catch(() => '') : ''
  return { ...(after ? { after } : {}), diffStat }
}

/** How a run reaches Farol's managed tools; `delegateId` names a subagent's run. */
export interface ManagedTools {
  /** The managed MCP server offering `tools` (Claude, Codex, ACP CLIs). */
  mcp(taskId: string, delegateId: string | undefined, tools: readonly ManagedTool[]): McpServerEntry
  /** Codex's Ask-first `PreToolUse` hook command (see `shared/codex-hook.ts`). */
  codexHook?(taskId: string, delegateId?: string): string
}

/**
 * A Codex run set to Ask first. Its hook can fail open (a timeout, or a Codex
 * that ignores hooks passed with `-c`), so every write or shell call it makes
 * must follow an approval Farol granted, one for one.
 */
interface Gate {
  credits: number
  seen: Set<string>
}

const PARENT_GATE = 'parent'

interface PendingApproval {
  event: Extract<AgentTaskEvent, { kind: 'approval' }>
  resolve: (answer: { allow: boolean; message?: string }) => void
}

/** The part of a tool call's input the developer needs to see to decide. */
function approvalDetail(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const fields = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500)
  }
  const json = JSON.stringify(input)
  return json === '{}' ? undefined : json.slice(0, 500)
}

/** A write or shell call, the kind auto-approve lets through without asking. */
function needsApproval(name: string): boolean {
  return isWriteToolName(name) || isShellToolName(name)
}

interface DelegateRun {
  card: ReturnType<typeof delegateCard>
  state: 'done' | 'error'
  diffStat: string
  message?: string
  before: string
  after: string
  undone?: 'undo' | 'restore'
}

function delegateCard(task: Task, delegateId: string, provider: AiProvider, model: string | undefined, work: string) {
  return {
    kind: 'delegate' as const,
    taskId: task.request.id,
    delegateId,
    ...(task.delegateToolId ? { parentToolId: task.delegateToolId } : {}),
    provider,
    ...(model ? { model } : {}),
    task: work
  }
}

/** What the asking agent reads back when its subagent is done. */
function delegateReport(headline: string, summary: string, diffStat: string): string {
  return [
    headline,
    summary ? `Summary:\n${summary}` : 'It gave no summary.',
    diffStat ? `Files it changed:\n${diffStat}` : 'It changed no files.'
  ].join('\n\n')
}

/** Record a file the agent wrote on the turn's scan. */
function noteWrite(scan: { filesChanged: boolean; changedTargets: string[] }, detail?: string): void {
  scan.filesChanged = true
  const target = detail?.trim()
  if (target && !scan.changedTargets.includes(target)) scan.changedTargets.push(target)
}

export class AgentController {
  private tasks = new Map<string, Task>()
  /** Chats whose files a revert is restoring; the agent must not start meanwhile. */
  private reverting = new Set<string>()

  constructor(
    private runner: ValidationRunner,
    private emit: (event: AgentTaskEvent) => void,
    private executor?: AgentExecutor,
    private todoStore?: TodoStore,
    private promptStore?: Pick<CustomPromptStore, 'activeBlock'>,
    private loadPipelines?: (cwd: string) => Promise<Pipeline[]>,
    /** Farol's managed tools for a task, for the providers that can take them per run. */
    private managed?: ManagedTools
  ) {}

  start(request: AgentTaskRequest): { ok: boolean; message?: string } {
    const clean = request.prompt.trim()
    const mode = normalizeMode(request.mode)
    if (!clean) return { ok: false, message: 'Enter a task for the agent.' }
    const existing = this.tasks.get(request.id)
    if (existing) {
      if (this.reverting.has(request.id)) return { ok: false, message: 'Wait for the revert to finish.' }
      if (existing.running) return { ok: false, message: 'An agent task with this id is already running.' }
      existing.request = {
        ...existing.request,
        ...request,
        prompt: existing.request.prompt,
        mode,
        pipelines: request.pipelines.filter((pipeline) => pipeline.nodes.length)
      }
      existing.fallbacks = [...(request.fallbacks ?? [])]
      existing.sameModelAttempts = 0
      this.emit({ kind: 'user', taskId: request.id, text: clean })
      this.followUp(existing, clean)
      return { ok: true }
    }
    if (mode !== 'plan' && !request.pipelines.some((pipeline) => pipeline.nodes.length)) {
      return { ok: false, message: 'Create a non-empty validation pipeline first.' }
    }
    const task: Task = {
      request: {
        ...request,
        prompt: request.prompt.trim(),
        mode,
        pipelines: request.pipelines.filter((pipeline) => pipeline.nodes.length)
      },
      process: null,
      child: null,
      delegating: false,
      delegateSeq: 0,
      delegateRuns: new Map(),
      notes: [],
      approvals: new Map(),
      approvalSeq: 0,
      allowedTools: new Set(),
      runAutoApproves: true,
      gates: new Map(),
      running: true,
      cancelled: false,
      disposeWhenIdle: false,
      guidance: [],
      pipelineRuns: [],
      todos: [],
      customInstructions: '',
      context: newAgentContext(clean),
      resumeAbandoned: false,
      abort: new AbortController(),
      mandatoryOutstanding: false,
      fallbacks: [...(request.fallbacks ?? [])],
      sameModelAttempts: 0,
      askEpoch: 0,
      questionSeq: 0,
      todoSeq: 0
    }
    this.tasks.set(request.id, task)
    this.emit({ kind: 'user', taskId: request.id, text: clean })
    // After a restart the renderer hands back the chat so far; this message
    // then continues it instead of starting over.
    const restored = sanitizeAgentContext(request.context)
    if (restored) {
      task.context = restored
      task.request.prompt = historyText(restored)
      this.followUp(task, clean)
      return { ok: true }
    }
    void this.cycle(task, { text: clean, continued: false })
    return { ok: true }
  }

  message(
    taskId: string,
    text: string,
    provider?: AiProvider,
    pipelines?: Pipeline[],
    model?: string,
    mode?: AgentTaskRequest['mode'],
    fallbacks?: ModelChoice[],
    cwd?: string,
    checkout?: string
  ): { ok: boolean; message?: string } {
    const task = this.tasks.get(taskId)
    const clean = text.trim()
    if (!task) return { ok: false, message: 'This agent task is no longer available.' }
    if (!clean) return { ok: false, message: 'Enter a message.' }
    if (this.reverting.has(taskId)) return { ok: false, message: 'Wait for the revert to finish.' }
    this.applyMessageOverrides(task, provider, model, mode, pipelines, fallbacks)
    if (cwd) task.request.cwd = cwd
    if (checkout) task.request.checkout = checkout
    this.emit({ kind: 'user', taskId, text: clean })
    if (task.pendingQuestions) {
      this.dismissPendingQuestions(task)
      this.followUp(task, clean)
      return { ok: true }
    }
    // Stop only aborts the in-flight run. A follow-up message resumes the same
    // chat — queue it if the cancelled cycle is still winding down.
    if (task.running) {
      task.guidance.push(clean)
      return { ok: true }
    }
    this.followUp(task, clean)
    return { ok: true }
  }

  /**
   * A provider switch mid-chat (e.g. after a usage limit) must stick before
   * the next cycle, including when the follow-up is only queued. Pipeline
   * edits (e.g. AI step provider) are snapshotted at start; refresh on every
   * follow-up so validation uses what the user configured now.
   */
  private applyMessageOverrides(
    task: Task,
    provider: AiProvider | undefined,
    model: string | undefined,
    mode: AgentTaskRequest['mode'] | undefined,
    pipelines: Pipeline[] | undefined,
    fallbacks: ModelChoice[] | undefined
  ): void {
    if (isAiProvider(provider)) {
      task.request.provider = provider
      task.request.model = normalizeModel(model)
      task.sameModelAttempts = 0
    }
    if (fallbacks) task.fallbacks = [...fallbacks]
    task.request.mode = normalizeMode(mode ?? task.request.mode)
    if (pipelines) {
      const next = pipelines.filter((pipeline) => pipeline.nodes.length)
      if (next.length) task.request.pipelines = next
    }
  }

  /** Dismiss a stale question card and clear the in-flight process before resuming. */
  private dismissPendingQuestions(task: Task): void {
    if (!task.pendingQuestions) return
    this.emit({
      kind: 'question',
      taskId: task.request.id,
      requestId: task.pendingQuestions.requestId,
      questions: task.pendingQuestions.questions,
      dismissed: true
    })
    task.pendingQuestions = undefined
    if (task.process?.pid) killPidTree(task.process.pid)
  }

  /** Switch provider on an existing task without sending a message. */
  setProvider(
    taskId: string,
    provider: AiProvider,
    model?: string,
    mode?: AgentTaskRequest['mode']
  ): { ok: boolean; message?: string } {
    const task = this.tasks.get(taskId)
    if (!task) return { ok: false, message: 'This agent task is no longer available.' }
    if (!isAiProvider(provider)) return { ok: false, message: 'Unknown agent provider.' }
    task.request.provider = provider
    task.request.model = normalizeModel(model)
    task.request.mode = normalizeMode(mode ?? task.request.mode)
    task.sameModelAttempts = 0
    return { ok: true }
  }

  cancel(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.cancelled = true
    task.pendingQuestions = undefined
    task.abort.abort()
    if (task.process?.pid) killPidTree(task.process.pid)
    if (task.child?.pid) killPidTree(task.child.pid)
    this.expireApprovals(task)
    this.status(task, 'cancelled', 0, 'Cancelled by user')
  }

  /**
   * Run a subagent for the agent's `delegate` call and resolve with what it
   * did. The agent is blocked on the call meanwhile, so the subagent has the
   * checkout to itself. `signal` aborts when the asking agent goes away.
   */
  async delegate(
    taskId: string,
    ask: { provider: string; model?: string; task: string; context?: string },
    signal?: AbortSignal
  ): Promise<{ ok: true; text: string; failed: boolean } | { ok: false; message: string }> {
    const task = this.tasks.get(taskId)
    const work = ask.task.trim()
    const refusal = this.delegateRefusal(task, ask.provider, work)
    if (refusal || !task || !isAiProvider(ask.provider)) return { ok: false, message: refusal ?? 'Unavailable.' }

    const provider = ask.provider
    const model = normalizeModel(ask.model)
    task.delegating = true
    task.activeDelegate = undefined
    task.delegateSeq += 1
    const delegateId = `${taskId}:d${task.delegateSeq}`
    const card = delegateCard(task, delegateId, provider, model, work)
    this.emit({ ...card, state: 'running' })
    const cwd = task.request.cwd
    const before = await captureTree(cwd).catch(() => undefined)

    task.activeDelegate = { id: delegateId, provider }
    this.setGate(task, delegateId, provider)
    const { sink, run } = this.delegateSink(task, delegateId, this.autoApproves(task, provider))
    const onAbort = (): void => {
      if (task.child?.pid) killPidTree(task.child.pid)
    }
    signal?.addEventListener('abort', onAbort)

    let code = 1
    try {
      const prompt = this.delegatePrompt(task, work, ask.context)
      code = this.executor
        ? await this.executor({ ...task.request, provider, model }, prompt, sink.text, sink.tool)
        : await this.runAgent(task, prompt, sink, false, { child: { provider, model, delegateId } })
    } catch (error) {
      run.diagnostics = `${run.diagnostics}\n${errorMessage(error)}`
    } finally {
      signal?.removeEventListener('abort', onAbort)
      task.child = null
      task.delegating = false
      task.activeDelegate = undefined
      task.gates.delete(delegateId)
    }

    const { after, diffStat } = await treeChanges(cwd, before)
    const stopped = task.cancelled || signal?.aborted === true
    const failed = stopped || code !== 0
    const label = aiSelectionLabel(provider, model)
    const message = delegateFailure(label, { stopped, failed, code, diagnostics: run.diagnostics })
    await this.reportDelegate(task, delegateId, card, { state: failed ? 'error' : 'done', diffStat, message, before, after })
    const summary = stripControlMarkerLines(run.lastTurn || plainText(run.said)).trim()
    return { ok: true, text: delegateReport(message ?? `${label} finished.`, summary, diffStat), failed }
  }

  /** Show how a subagent run ended; a run that changed files can be undone, failed or not, since a crash halfway still left edits. */
  private async reportDelegate(
    task: Task,
    delegateId: string,
    card: DelegateRun['card'],
    end: { state: DelegateRun['state']; diffStat: string; message?: string; before?: string; after?: string }
  ): Promise<void> {
    const { state, diffStat, message, before, after } = end
    const note = message ? { message } : {}
    const undoable =
      !!(before && after && diffStat) &&
      (await this.keepRun(task, delegateId, { card, state, diffStat, ...note, before: before!, after: after! }))
    this.emit({ ...card, state, diffStat, ...note, ...(undoable ? { undoable } : {}) })
  }

  /** Pin a run's snapshots so Undo can use them; false when git would not keep them. */
  private async keepRun(task: Task, delegateId: string, run: DelegateRun): Promise<boolean> {
    try {
      await pinTree(task.request.cwd, task.request.id, delegateId, 'before', run.before)
      await pinTree(task.request.cwd, task.request.id, delegateId, 'after', run.after)
    } catch {
      return false
    }
    task.delegateRuns.set(delegateId, run)
    return true
  }

  /**
   * Undo one subagent run: reverse exactly its changes, keeping later edits
   * that do not overlap. With `restore`, put the whole checkout back to how
   * it was before the run, discarding everything since — the way out when
   * the plain undo would conflict. Only while the chat is idle.
   */
  async undoDelegate(
    taskId: string,
    delegateId: string,
    restore = false
  ): Promise<{ ok: true } | { ok: false; message: string; restoreFiles?: number }> {
    const task = this.tasks.get(taskId)
    const run = task?.delegateRuns.get(delegateId)
    if (!task || !run) return { ok: false, message: 'This subagent run can no longer be undone.' }
    if (task.running) return { ok: false, message: 'Wait for the agent to finish, then undo.' }
    if (run.undone) return { ok: false, message: 'Already undone.' }
    const cwd = task.request.cwd
    try {
      if (restore) await restoreTree(cwd, run.before)
      else {
        const outcome = await undoChange(cwd, run.before, run.after)
        if (!outcome.ok) {
          return {
            ok: false,
            message: 'Later changes overlap with this subagent’s, so nothing was undone.',
            restoreFiles: outcome.restoreFiles
          }
        }
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
    run.undone = restore ? 'restore' : 'undo'
    const label = aiSelectionLabel(run.card.provider, run.card.model)
    task.notes.push(
      restore
        ? `Note from Farol: the developer restored the checkout to how it was before the ${label} subagent ran (task: ${run.card.task}). Every change since then, including later ones, is gone.`
        : `Note from Farol: the developer undid the ${label} subagent's changes (task: ${run.card.task}). These are reverted:\n${run.diffStat}`
    )
    this.emit({
      ...run.card,
      state: run.state,
      diffStat: run.diffStat,
      ...(run.message ? { message: run.message } : {}),
      undone: run.undone
    })
    return { ok: true }
  }

  /**
   * Whether a run on `provider` approves tools without asking: always, unless
   * the chat turned auto-approve off and the CLI can ask (and is in Build,
   * where there is something to approve, with the managed server to ask through).
   */
  private autoApproves(task: Task, provider: AiProvider): boolean {
    // Claude asks through the managed server, Codex through its hook, ACP CLIs over ACP itself.
    const via = openRouterAgent()
    const route =
      provider === 'codex' ? !!this.managed?.codexHook : ACP_CLIS.includes(cliFor(provider, via)) || !!this.managed
    return !(task.request.autoApprove === false && canAskApproval(provider, via) && task.request.mode !== 'plan' && route)
  }

  /** Open (or clear) the Ask-first gate for a run that is about to start. */
  private setGate(task: Task, key: string, provider: AiProvider): void {
    const gated =
      !this.autoApproves(task, provider) && cliFor(provider, openRouterAgent()) === 'codex' && !!this.managed?.codexHook
    if (gated) task.gates.set(key, { credits: 0, seen: new Set() })
    else task.gates.delete(key)
  }

  /** An approval the developer granted lets one write or shell call through its run's gate. */
  private creditGate(task: Task, delegateId: string | undefined, toolName: string): void {
    const gate = task.gates.get(delegateId ?? PARENT_GATE)
    if (gate && needsApproval(toolName)) gate.credits += 1
  }

  /** Why a gated run must stop: a write or shell call ran that nobody approved. */
  private passGate(task: Task, key: string, event: { toolId: string; name: string }): string | undefined {
    const gate = task.gates.get(key)
    if (!gate || !needsApproval(event.name) || gate.seen.has(event.toolId)) return undefined
    gate.seen.add(event.toolId)
    if (gate.credits > 0) {
      gate.credits -= 1
      return undefined
    }
    return `Codex ran ${event.name} without asking, so Farol stopped it. Ask first is not working with this Codex version; turn on Auto-approve to keep using Codex, or switch to Claude.`
  }

  /** Turn auto-approve on or off; the next run picks it up, a running one keeps its own. */
  setAutoApprove(taskId: string, on: boolean): { ok: boolean; message?: string } {
    const task = this.tasks.get(taskId)
    if (!task) return { ok: false, message: 'This agent task is no longer available.' }
    task.request.autoApprove = on
    return { ok: true }
  }

  /**
   * Ask the developer whether a tool call may run, for Claude's permission
   * prompt. Resolves when they answer, or with a deny when nobody can any
   * more: the turn was stopped or the asking agent went away (`signal`).
   */
  requestApproval(
    taskId: string,
    ask: { toolName: string; input: unknown; delegateId?: string },
    signal?: AbortSignal
  ): Promise<{ allow: boolean; message?: string }> {
    const task = this.tasks.get(taskId)
    if (!task?.running || task.cancelled) return Promise.resolve({ allow: false, message: 'This Chat turn is no longer running.' })
    if (task.allowedTools.has(ask.toolName)) {
      this.creditGate(task, ask.delegateId, ask.toolName)
      return Promise.resolve({ allow: true })
    }
    task.approvalSeq += 1
    const requestId = `${taskId}:a${task.approvalSeq}`
    const delegate = ask.delegateId && task.activeDelegate?.id === ask.delegateId ? task.activeDelegate : undefined
    const detail = approvalDetail(ask.input)
    const event: PendingApproval['event'] = {
      kind: 'approval',
      taskId,
      requestId,
      provider: delegate?.provider ?? task.request.provider,
      ...(delegate ? { delegateId: delegate.id } : {}),
      toolName: ask.toolName,
      ...(detail ? { detail } : {})
    }
    return new Promise((resolve) => {
      const settle = (answer: { allow: boolean; message?: string }): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve(answer)
      }
      const onAbort = (): void => this.settleApproval(task, requestId, 'expired')
      task.approvals.set(requestId, { event, resolve: settle })
      signal?.addEventListener('abort', onAbort)
      this.emit(event)
    })
  }

  /** The developer's answer to an approval request. */
  respondApproval(taskId: string, requestId: string, decision: 'once' | 'chat' | 'deny'): { ok: boolean; message?: string } {
    const task = this.tasks.get(taskId)
    if (!task?.approvals.has(requestId)) return { ok: false, message: 'This request is no longer waiting.' }
    this.settleApproval(task, requestId, decision)
    return { ok: true }
  }

  private settleApproval(task: Task, requestId: string, decision: ApprovalDecision): void {
    const pending = task.approvals.get(requestId)
    if (!pending) return
    task.approvals.delete(requestId)
    if (decision === 'chat') task.allowedTools.add(pending.event.toolName)
    if (decision === 'once' || decision === 'chat') this.creditGate(task, pending.event.delegateId, pending.event.toolName)
    this.emit({ ...pending.event, decision })
    pending.resolve(
      decision === 'once' || decision === 'chat'
        ? { allow: true }
        : {
            allow: false,
            message:
              decision === 'deny'
                ? 'The developer declined this tool call. Do not retry it; ask or take another approach.'
                : 'Nobody could approve this tool call (the turn was stopped), so it did not run.'
          }
    )
  }

  private expireApprovals(task: Task): void {
    for (const requestId of task.approvals.keys()) this.settleApproval(task, requestId, 'expired')
  }

  /** Why a `delegate` call cannot start, or undefined when it can. */
  private delegateRefusal(task: Task | undefined, provider: string, work: string): string | undefined {
    if (!task?.running || task.cancelled) return 'No Chat turn is running for this task.'
    if (!isAiProvider(provider)) return `Unknown provider: ${provider}`
    if (!work) return 'Describe the task for the subagent.'
    if (task.delegating) return 'A subagent is already running. Wait for it to finish.'
    return undefined
  }

  /** Routes a subagent's output to its card and records what it wrote and said. */
  private delegateSink(task: Task, delegateId: string, autoApproves: boolean) {
    const taskId = task.request.id
    const scan = task.activeScan
    const run = { said: '', lastTurn: '', diagnostics: '' }
    const sink: AgentSink = {
      text: (chunk) => {
        run.said = (run.said + chunk).slice(-SCAN_WINDOW)
        this.emit({ kind: 'output', taskId, chunk, delegateId })
      },
      turn: (text) => {
        run.lastTurn = text
        run.said = `${run.said}\n${text}`.slice(-SCAN_WINDOW)
        this.emit({ kind: 'assistant', taskId, text, delegateId })
      },
      tool: (event) => {
        const breach = this.passGate(task, delegateId, event)
        if (breach) {
          run.diagnostics = `${run.diagnostics}\n${breach}`
          if (task.child?.pid) killPidTree(task.child.pid)
        }
        const auto = autoApproves && needsApproval(event.name)
        this.emit({ kind: 'tool', taskId, ...event, toolId: `${delegateId}:${event.toolId}`, delegateId, ...(auto ? { auto } : {}) })
        if (event.state !== 'done' || !isWriteToolName(event.name)) return
        task.mandatoryOutstanding = true
        if (scan) noteWrite(scan, event.detail)
      },
      // A subagent cannot stop to ask; its prompt says to report open questions instead.
      question: () => undefined,
      noise: (chunk) => {
        run.diagnostics = (run.diagnostics + chunk).slice(-SCAN_WINDOW)
      }
    }
    return { sink, run }
  }

  private delegatePrompt(task: Task, work: string, context?: string): string {
    const plan = task.request.mode === 'plan'
    const handoff = task.context.handoff?.trim()
    return [
      `You are a subagent. Another coding agent, working in Farol, handed you the task below and is waiting for your result.`,
      `Work only in ${task.request.cwd}. Nobody else edits these files while you run.`,
      plan
        ? `This is read-only: inspect and report, but do not change project files or modify external systems.`
        : `You may change files as the task needs. Do not run git commands that commit, push, or rewrite history.`,
      `You cannot ask the user anything. If something is unclear, make the most reasonable choice and say so, or stop and report what you need.`,
      `Do not run Farol pipelines and do not print Farol control lines (lines starting with FAROL_). The agent that called you decides on validation.`,
      `Finish with a short summary: what you did, what you found, and anything left open.`,
      handoff ? `\nWhere the chat stands (the calling agent's handoff note):\n${handoff}` : '',
      context?.trim() ? `\nContext from the calling agent:\n${context.trim()}` : '',
      `\nTask:\n${work}`
    ]
      .filter(Boolean)
      .join('\n')
  }

  /**
   * Resume after an `asking` turn. `answers: null` means the user dismissed
   * the chooser; otherwise one string[] of labels per question, OpenCode-style.
   */
  answer(
    taskId: string,
    requestId: string,
    answers: string[][] | null
  ): { ok: boolean; message?: string } {
    const task = this.tasks.get(taskId)
    if (!task?.pendingQuestions) return { ok: false, message: 'There is no question waiting.' }
    if (task.pendingQuestions.requestId !== requestId) {
      return { ok: false, message: 'These questions are no longer current.' }
    }
    const pending = task.pendingQuestions
    let resolved: string[][] | null = null
    if (answers !== null) {
      const checked = validateAnswers(pending.questions, answers)
      if ('error' in checked) return { ok: false, message: checked.error }
      resolved = checked.answers
    }
    task.pendingQuestions = undefined
    this.emit({
      kind: 'question',
      taskId,
      requestId,
      questions: pending.questions,
      ...(resolved ? { answers: resolved } : { dismissed: true })
    })
    if (task.process?.pid) killPidTree(task.process.pid)
    this.followUp(task, formatAnswers(pending.questions, resolved))
    return { ok: true }
  }

  /**
   * Start the chat over in a new CLI session without clearing it. While the
   * old session is still resumable, the agent first writes a handoff note
   * from everything it holds (read-only, Plan mode); the next message then
   * starts a new session from the task, the latest requests and that note.
   * Failures leave the session as it was; those after the note turn started
   * are reported as a status and return no message.
   */
  async freshStart(taskId: string): Promise<{ ok: boolean; message?: string; missing?: boolean }> {
    const task = this.tasks.get(taskId)
    if (!task) return { ok: false, missing: true, message: 'This agent task is no longer available.' }
    if (task.running || task.pendingQuestions) {
      return { ok: false, message: 'Wait for the agent to finish, or stop it, before a fresh start.' }
    }
    task.running = true
    task.cancelled = false
    task.abort = new AbortController()
    const resume = resumableSession(task.context, cliFor(task.request.provider, openRouterAgent()), task.request.cwd)
    let handoff = task.context.handoff
    if (resume) {
      this.status(task, 'working', 0, 'Writing a handoff note for a fresh start')
      const note = await this.writeHandoff(task, resume)
      if (task.cancelled || task.disposeWhenIdle) {
        this.settleCancel(task)
        return { ok: false }
      }
      if (!note) {
        this.finishOrContinue(
          task,
          0,
          'needs-attention',
          'Fresh start stopped: the agent did not write a handoff note. The current session is unchanged.'
        )
        return { ok: false }
      }
      handoff = note
      this.emit({ kind: 'assistant', taskId, text: `Handoff note for the fresh start:\n\n${note}` })
    }
    task.context = {
      ...task.context,
      // The note covers what came before; the latest requests stay verbatim.
      followUps: handoff ? task.context.followUps.slice(-FRESH_START_KEEP_FOLLOW_UPS) : task.context.followUps,
      ...(handoff ? { handoff } : {})
    }
    task.request.prompt = historyText(task.context)
    if (task.context.session) this.forgetSession(task)
    else this.emitContext(task)
    this.finishOrContinue(
      task,
      0,
      'completed',
      'Fresh start: the next message starts a new session from the task, the latest requests and the handoff note.'
    )
    return { ok: true }
  }

  /** One read-only turn on the old session that only writes the handoff note. */
  private async writeHandoff(task: Task, resume: string): Promise<string | undefined> {
    const prompt = [
      `Farol is about to move this chat to a new session because its context is large. Write the handoff note the new session will start from.`,
      `It sees only the original task, the latest one or two user requests, and this note — make it specific and self-contained: the goal, what is done, decisions and why, dead ends to avoid, the files involved, and the next step.`,
      `Do not change files or run commands. Reply with only one line: ${HANDOFF_MARKER} "<JSON string>", at most ${MAX_HANDOFF_CHARS} characters.`
    ].join('\n\n')
    let said = ''
    const sink: AgentSink = {
      text: (chunk) => {
        said = (said + chunk).slice(-SCAN_WINDOW)
      },
      turn: (text) => {
        said = `${said}\n${text}`.slice(-SCAN_WINDOW)
      },
      tool: () => {},
      question: () => {},
      noise: () => {}
    }
    const session: AgentSessionIo = { resume, onSession: () => {} }
    const mode = task.request.mode
    task.request.mode = 'plan'
    let code: number
    try {
      code = this.executor
        ? await this.executor(task.request, prompt, sink.text, undefined, session)
        : await this.runAgent(task, prompt, sink, false, { session })
    } catch {
      code = 1
    } finally {
      task.request.mode = mode
    }
    return code === 0 ? parseHandoffMarker(said) : undefined
  }

  /** Where a chat's checkpoints live: its checkout, or `cwd` once a restart has dropped the task. */
  private checkpointCwd(taskId: string, cwd?: string): string | undefined {
    return this.tasks.get(taskId)?.request.cwd ?? cwd
  }

  turns(taskId: string, cwd?: string): Promise<TurnInfo[]> {
    const dir = this.checkpointCwd(taskId, cwd)
    return dir ? listTurns(dir, taskId).catch(() => []) : Promise.resolve([])
  }

  revertPreview(taskId: string, turn: number, cwd?: string): ReturnType<typeof previewRevert> {
    const dir = this.checkpointCwd(taskId, cwd)
    return dir ? previewRevert(dir, taskId, turn).catch((error) => ({ message: errorMessage(error) })) : Promise.resolve({ message: 'This chat has no checkout.' })
  }

  /**
   * Put the files back to before a turn. Files only: the agent's own memory
   * still holds the later turns, so its next turn is told what changed.
   * Refused while it works, since it would write over the restored files.
   */
  async revertTurn(taskId: string, turn: number, cwd?: string): Promise<RevertOutcome> {
    const task = this.tasks.get(taskId)
    const dir = this.checkpointCwd(taskId, cwd)
    if (!dir) return { ok: false, message: 'This chat has no checkout.' }
    if (task?.running) return { ok: false, message: 'Stop the agent, or wait for it to finish, before reverting.' }
    if (this.reverting.has(taskId)) return { ok: false, message: 'A revert is already running.' }
    this.reverting.add(taskId)
    try {
      const outcome = await revertToTurn(dir, taskId, turn, task?.request.checkpointLimit)
      if (outcome.ok) {
        task?.notes.push(
          `Note from Farol: the developer reverted the files to how they were before turn ${turn}. ${outcome.fileCount} file(s) changed back. Your memory of the later turns is still there, but their file changes are gone: read files again before you edit them.`
        )
      }
      this.emit({ kind: 'turns', taskId })
      return outcome
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    } finally {
      this.reverting.delete(taskId)
    }
  }

  /**
   * Cancel and release the task. Cleared/closed chats must not leave prompt
   * history and pipeline catalogs resident for the rest of the session.
   */
  dispose(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.disposeWhenIdle = true
    task.guidance.length = 0
    if (task.delegateRuns.size) {
      task.delegateRuns.clear()
      void releaseTrees(task.request.cwd, taskId).catch(() => undefined)
    }
    void releaseCheckpoints(task.request.cwd, taskId)
    this.cancel(taskId)
    if (!task.running) this.tasks.delete(taskId)
  }

  /** Chats the main process still holds, whatever their state. */
  taskIds(): string[] {
    return [...this.tasks.keys()]
  }

  cancelAll(): void {
    for (const id of this.tasks.keys()) this.cancel(id)
  }

  private releaseIfDisposed(task: Task): void {
    if (task.disposeWhenIdle && !task.running) this.tasks.delete(task.request.id)
  }

  private status(task: Task, status: AgentTaskStatus, attempt: number, message: string): void {
    this.emit({ kind: 'status', taskId: task.request.id, status, attempt, message })
  }

  private pipelineStatus(task: Task, activity: PipelineActivity): void {
    this.emit({ kind: 'pipeline', taskId: task.request.id, ...activity })
  }

  /** Park the cycle until the user answers — no validation on this turn. */
  private pauseForQuestions(
    task: Task,
    attempt: number,
    questions: AgentQuestion[],
    requestId?: string
  ): void {
    const id = requestId ?? `${task.request.id}:q${++task.questionSeq}`
    task.pendingQuestions = { requestId: id, questions }
    task.running = false
    this.emit({ kind: 'question', taskId: task.request.id, requestId: id, questions })
    this.status(task, 'asking', attempt, 'Waiting for your answers')
  }

  /** Append a user follow-up and start a new cycle that continues the chat. */
  private followUp(task: Task, message: string): void {
    // Farol's own notes (an Undo) go first, and into the history like the message.
    const notes = task.notes.splice(0).join('\n')
    const userText = notes ? `${notes}\n\n${message}` : message
    task.askEpoch += 1
    task.context = addFollowUp(task.context, userText)
    task.request.prompt = historyText(task.context)
    this.resume(task, userText)
  }

  /**
   * End the current cycle. If the user already queued a follow-up (often with a
   * new provider after a usage limit), keep going instead of leaving it stranded.
   */
  private finishOrContinue(
    task: Task,
    attempt: number,
    status: AgentTaskStatus,
    message: string
  ): void {
    task.running = false
    this.status(task, status, attempt, message)
    if (task.disposeWhenIdle) {
      this.releaseIfDisposed(task)
      return
    }
    if (!task.guidance.length) return
    const text = task.guidance.splice(0).join('\n')
    this.followUp(task, text)
  }

  /** Clear a user stop and start a new agent cycle for the same task. */
  private resume(task: Task, userText: string): void {
    task.cancelled = false
    task.abort = new AbortController()
    task.running = true
    void this.cycle(task, continued(`User request: ${userText}`))
  }

  /**
   * Exit a cancelled cycle. If the user already typed a follow-up while Stop
   * was landing, start that run instead of leaving the chat dead.
   */
  private settleCancel(task: Task): void {
    task.running = false
    if (task.disposeWhenIdle) {
      this.releaseIfDisposed(task)
      return
    }
    if (!task.cancelled || !task.guidance.length) return
    const text = task.guidance.splice(0).join('\n')
    this.followUp(task, text)
  }

  /** If the user typed while a cycle was finishing, run their message next. */
  private continueIfGuidanceOpening(task: Task): Opening | null {
    const guidance = task.guidance.splice(0).join('\n')
    if (!guidance) return null
    return continued(`User request:\n${guidance}`)
  }

  private cycleSink(task: Task, scan: CycleScan): AgentSink {
    const check = (): void => {
      const agentStop = blockedMarker(scan.assistant)
      const reason = agentStop ?? providerFailure(scan.noise)
      if (!scan.blocked && reason) {
        scan.blocked = reason
        scan.blockedByProvider = !agentStop
        if (task.process?.pid) killPidTree(task.process.pid)
      }
    }
    return {
      text: (chunk) => {
        this.emit({ kind: 'output', taskId: task.request.id, chunk })
        scan.assistant = (scan.assistant + chunk).slice(-SCAN_WINDOW)
        scan.output = (scan.output + chunk).slice(-SCAN_WINDOW)
        appendControlLines(scan, chunk)
        check()
      },
      turn: (text) => {
        this.emit({ kind: 'assistant', taskId: task.request.id, text })
        scan.assistant = (`${scan.assistant}\n${text}`).slice(-SCAN_WINDOW)
        scan.output = (`${scan.output}\n${text}`).slice(-SCAN_WINDOW)
        appendControlLines(scan, `${text}\n`)
        check()
      },
      tool: (event) => {
        if (event.state === 'running' && isDelegateToolName(event.name)) task.delegateToolId = event.toolId
        const breach = this.passGate(task, PARENT_GATE, event)
        if (breach && !scan.blocked) {
          scan.blocked = breach
          scan.blockedByProvider = false
          if (task.process?.pid) killPidTree(task.process.pid)
        }
        const auto = task.runAutoApproves && needsApproval(event.name)
        this.emit({ kind: 'tool', taskId: task.request.id, ...event, ...(auto ? { auto } : {}) })
        scan.toolNames.push(event.name)
        // Codex sometimes only fills command on item.completed; accept either.
        if (event.detail && isShellToolName(event.name) && event.state !== 'error') {
          scan.shellInvocations.push(event.detail)
        }
        if (event.state === 'done' && isWriteToolName(event.name)) {
          scan.filesChanged = true
          task.mandatoryOutstanding = true
          const target = event.detail?.trim()
          if (target && !scan.changedTargets.includes(target)) scan.changedTargets.push(target)
        }
      },
      question: (questions) => {
        if (!questions.length) return
        scan.questions = questions
        if (!scan.questionId) {
          task.questionSeq += 1
          scan.questionId = `${task.request.id}:q${task.questionSeq}`
        }
        task.pendingQuestions = { requestId: scan.questionId, questions }
        this.emit({
          kind: 'question',
          taskId: task.request.id,
          requestId: scan.questionId,
          questions
        })
        this.status(task, 'asking', 0, 'Waiting for your answers')
        if (task.process?.pid) killPidTree(task.process.pid)
      },
      noise: (chunk) => {
        scan.output = (scan.output + chunk).slice(-SCAN_WINDOW)
        scan.noise = (scan.noise + chunk).slice(-SCAN_WINDOW)
        check()
      }
    }
  }

  private async loadTodos(task: Task): Promise<void> {
    if (!this.todoStore) return
    task.todos = await this.todoStore.load(task.request.checkout).catch(() => task.todos)
  }

  private async loadCustomInstructions(task: Task): Promise<void> {
    if (!this.promptStore) return
    task.customInstructions = await this.promptStore.activeBlock(task.request.checkout).catch(() => '')
  }

  private async applyTodos(task: Task, assistant: string): Promise<void> {
    if (task.disposeWhenIdle) return
    const todos = parseTodosMarker(assistant)
    if (!todos) return
    const previous = task.todos
    task.todos = todos
    task.todoSeq += 1
    const toolId = `${task.request.id}:todos:${task.todoSeq}`
    try {
      await this.todoStore?.save(task.request.checkout, todos, previous)
      this.emit({
        kind: 'tool',
        taskId: task.request.id,
        toolId,
        name: 'todo',
        detail: todoSummary(todos),
        state: 'done'
      })
    } catch (error) {
      task.todos = previous
      this.emit({
        kind: 'tool',
        taskId: task.request.id,
        toolId,
        name: 'todo',
        detail: error instanceof Error ? error.message : 'Could not save the todo list',
        state: 'error'
      })
    }
  }

  /** Keep the CLI's session id so the next turn on this CLI and directory resumes it. */
  private recordSession(task: Task, provider: AiProvider, id: string): void {
    if (task.disposeWhenIdle) return
    const current = task.context.session
    const cli = cliFor(provider, openRouterAgent())
    if (current?.cli === cli && current.id === id && current.cwd === task.request.cwd) return
    task.context = { ...task.context, session: { cli, id, cwd: task.request.cwd } }
    this.emitContext(task)
  }

  /**
   * A resumed run that failed before the agent said anything usually means the
   * CLI would not continue its session (expired, deleted, an older build), and
   * one that ran out of context cannot continue it. Drop the session and
   * retry once on a new one with the rebuilt history — not a provider
   * failure, so no retry budget is spent. Once per cycle, so a CLI that fails
   * every run still reaches the normal retry and fallback path.
   */
  private abandonResume(task: Task, scan: CycleScan, code: number): boolean {
    if (!scan.resumed || task.resumeAbandoned) return false
    const contextFull = scan.blockedByProvider && /context length/i.test(scan.blocked ?? '')
    const missing = code !== 0 && /session not found/i.test(scan.output)
    const refused = code !== 0 && !scan.blocked && (missing || !scan.assistant.trim())
    if (!contextFull && !refused) return false
    task.resumeAbandoned = true
    this.forgetSession(task)
    return true
  }

  private forgetSession(task: Task): void {
    if (!task.context.session) return
    task.context = { ...task.context, session: undefined }
    this.emitContext(task)
    // The reading described that session; the next run measures its own.
    task.usage = undefined
    this.emit({ kind: 'usage', taskId: task.request.id, usage: null })
  }

  private recordUsage(task: Task, provider: AiProvider, model: string | undefined, reading: ContextUsage): void {
    if (task.disposeWhenIdle || !(reading.tokens > 0)) return
    const cli = cliFor(provider, openRouterAgent())
    const window =
      reading.window ?? (cli === 'claude' ? claudeCatalogWindow(model) : undefined) ?? knownContextWindow(cli, model)
    const usage: ContextUsage = { tokens: reading.tokens, ...(window ? { window } : {}) }
    if (task.usage?.tokens === usage.tokens && task.usage.window === usage.window) return
    task.usage = usage
    this.emit({ kind: 'usage', taskId: task.request.id, usage })
  }

  private applyHandoff(task: Task, control: string): void {
    if (task.disposeWhenIdle) return
    const handoff = parseHandoffMarker(control)
    if (!handoff || handoff === task.context.handoff) return
    task.context = { ...task.context, handoff }
    this.emitContext(task)
  }

  /** Hand the renderer what it must save to continue this chat after a restart. */
  private emitContext(task: Task): void {
    const { handoff, session } = task.context
    this.emit({
      kind: 'context',
      taskId: task.request.id,
      context: { ...(handoff ? { handoff } : {}), ...(session ? { session } : {}) }
    })
  }

  private async runValidationPipelines(
    task: Task,
    pipelines: Pipeline[],
    attempt: number
  ): Promise<
    | { kind: 'cancelled' }
    | { kind: 'stopped' }
    | { kind: 'passed' }
    | { kind: 'failed'; failures: { pipeline: Pipeline; result: PipelineRunResult }[] }
  > {
    const failures: { pipeline: Pipeline; result: PipelineRunResult }[] = []
    for (const pipeline of pipelines) {
      const activity: PipelineActivity = {
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        status: 'running',
        startedAt: Date.now()
      }
      task.pipelineRuns.push(activity)
      if (task.pipelineRuns.length > MAX_PIPELINE_RUNS) {
        task.pipelineRuns.splice(0, task.pipelineRuns.length - MAX_PIPELINE_RUNS)
      }
      this.pipelineStatus(task, activity)
      let result: PipelineRunResult
      try {
        result = await this.runner.run(
          pipeline,
          task.request.cwd,
          task.request.branch,
          'managed-agent',
          task.abort.signal
        )
      } catch (error) {
        activity.status = 'failed'
        activity.finishedAt = Date.now()
        activity.durationMs = activity.finishedAt - activity.startedAt
        if (activity.runId === undefined) activity.runId = `error:${activity.startedAt}`
        this.pipelineStatus(task, activity)
        throw error
      }
      activity.status = activityStatus(result)
      activity.finishedAt = Date.now()
      activity.durationMs = activity.finishedAt - activity.startedAt
      activity.runId = result.runId
      this.pipelineStatus(task, activity)
      if (task.cancelled) return { kind: 'cancelled' }
      if (result.cancelled) {
        task.running = false
        this.status(task, 'needs-attention', attempt, 'Validation stopped unexpectedly')
        this.releaseIfDisposed(task)
        return { kind: 'stopped' }
      }
      if (!result.ok) failures.push({ pipeline, result })
    }
    if (!failures.length) return { kind: 'passed' }
    return { kind: 'failed', failures }
  }

  private completeCycle(task: Task, attempt: number, message: string): CycleAttemptResult {
    const next = this.continueIfGuidanceOpening(task)
    if (next) return { kind: 'retry', opening: next }
    task.running = false
    this.status(task, 'completed', attempt, message)
    this.releaseIfDisposed(task)
    return { kind: 'done' }
  }

  /**
   * The request holds the pipelines as they were at the last user message, but the user can edit one (say,
   * switch it from remote to this machine) while fixes and validation cycles go on. Run what is saved now.
   */
  private async refreshPipelines(task: Task): Promise<void> {
    if (!this.loadPipelines) return
    const saved = new Map((await this.loadPipelines(task.request.cwd)).map((pipeline) => [pipeline.id, pipeline]))
    task.request.pipelines = task.request.pipelines.map((pipeline) => {
      const next = saved.get(pipeline.id)
      return next?.nodes.length ? next : pipeline
    })
  }

  /** Pick pipelines from the agent's marker and run them, or retry if invalid. */
  private async finishCycleAttempt(
    task: Task,
    attempt: number,
    scan: CycleScan
  ): Promise<CycleAttemptResult> {
    if (task.request.mode === 'plan') return this.finishPlanCycleAttempt(task, attempt, scan)
    await this.refreshPipelines(task)
    const selection = selectedPipelines(scan.control, task.request.pipelines)
    const retryInvalid = (reason: string): CycleAttemptResult => ({
      kind: 'retry',
      opening: continued(`Farol could not validate because ${reason}`)
    })
    if (selection.error) {
      return retryInvalid(`your pipeline selection was invalid: ${selection.error}`)
    }

    const bypass = catalogShellBypassError(
      scan.shellInvocations,
      task.request.pipelines,
      selection.pipelines
    )
    if (bypass) return retryInvalid(`you bypassed pipelines: ${bypass}`)

    const mustRunMandatory = scan.filesChanged || task.mandatoryOutstanding
    const mandatoryBypass = mandatoryOptOutError(
      task.request.pipelines,
      selection.pipelines,
      mustRunMandatory
    )
    if (mandatoryBypass) return retryInvalid(`you skipped mandatory pipelines: ${mandatoryBypass}`)

    // Jev may only add to what the agent already picked, never drop from it —
    // it has no say when there is nothing to validate (no file change, no
    // outstanding mandatory retry).
    const advised = mustRunMandatory
      ? await this.jevAdvisedPipelines(task, scan, selection.pipelines, attempt)
      : []
    const withJev = advised.length ? [...selection.pipelines, ...advised] : selection.pipelines

    const pipelines = mustRunMandatory
      ? mergeWithMandatory(task.request.pipelines, withJev)
      : withJev.filter((pipeline) => pipeline.mandatory !== true)

    // Mandatory pipelines do not run unless files changed (or a previous
    // mandatory run is still waiting to pass).
    if (!pipelines.length) return this.completeCycle(task, attempt, 'No validation needed')

    const names = pipelines.map((pipeline) => pipeline.name).join(', ')
    this.status(task, 'validating', attempt, `Running ${names}`)
    const outcome = await this.runValidationPipelines(task, pipelines, attempt)
    return this.handleValidationOutcome(task, attempt, outcome, names)
  }

  private handleValidationOutcome(
    task: Task,
    attempt: number,
    outcome: Awaited<ReturnType<AgentController['runValidationPipelines']>>,
    names: string
  ): CycleAttemptResult {
    if (outcome.kind === 'cancelled') {
      this.settleCancel(task)
      return { kind: 'done' }
    }
    if (outcome.kind === 'stopped') return { kind: 'done' }
    if (outcome.kind === 'passed') {
      task.mandatoryOutstanding = false
      return this.completeCycle(task, attempt, `${names} passed`)
    }

    if (outcome.failures.some(({ pipeline }) => pipeline.mandatory === true)) task.mandatoryOutstanding = true
    const guidance = task.guidance.splice(0).join('\n')
    return {
      kind: 'retry',
      opening: continued(repairPromptOpening(attempt, outcome.failures, guidance))
    }
  }

  /**
   * Pipelines the agent did not select but Jev is confident belong in this
   * turn's run. Only opted-in (`autoSelectable`) non-mandatory pipelines are
   * offered — Jev is never asked about one the agent (or `mergeWithMandatory`
   * later) already covers. Any failure — no key, a slow gateway, a bad answer
   * — yields `[]`, leaving the agent's own selection exactly as it was.
   */
  private async jevAdvisedPipelines(
    task: Task,
    scan: CycleScan,
    selected: Pipeline[],
    attempt: number
  ): Promise<Pipeline[]> {
    const candidates = task.request.pipelines.filter(
      (pipeline) =>
        pipeline.mandatory !== true &&
        pipeline.autoSelectable === true &&
        !selected.includes(pipeline)
    )
    if (!candidates.length) return []
    const state = pipelineSelectionState({
      task: task.request.prompt,
      assistant: scan.assistant,
      changedTargets: scan.changedTargets,
      selected,
      mandatory: mandatoryPipelines(task.request.pipelines)
    })
    const ids = await selectPipelines(candidates, state, { attempt })
    return candidates.filter((pipeline) => ids?.includes(pipeline.id))
  }

  /**
   * Resolve the turn's tool policy. Build asks Jev for a focus among all
   * host-prepared foci and remaps across retries; uncertain → full tools.
   * Plan asks Jev only among read-only foci (`inspect` / `answer`) and soft-fails
   * to inspect — never to the full set. Provider review gates stay the hard
   * enforcement. `toolPolicyFor` rejects stale or unknown foci before apply.
   */
  private async resolveToolPolicy(
    task: Task,
    opening: string,
    attempt: number
  ): Promise<ToolPolicy> {
    const mode = task.request.mode === 'plan' ? 'plan' : 'build'
    if (task.toolSelection && task.toolSelectionAttempt === attempt) {
      return toolPolicyFor(task.request.provider, task.toolSelection, openRouterAgent())
    }
    const state = toolSelectionState({
      task: task.request.prompt,
      opening,
      mode,
      attempt
    })
    const selected = await selectTools(state, { attempt, mode })
    const resolved: ToolSelection =
      selected ??
      (mode === 'plan' ? defaultPlanSelection() : { kind: 'fallback-full', reason: 'jev-unavailable' })
    task.toolSelection = resolved
    task.toolSelectionAttempt = attempt
    return toolPolicyFor(task.request.provider, resolved, openRouterAgent())
  }

  /** Diagnostic-only: log omitted-family tool cards without killing the run. */
  private observeTools(task: Task, policy: ToolPolicy, toolNames: string[], attempt: number): void {
    const observation = observeToolUse(policy, toolNames)
    if (!observation.violations.length && !observation.unknownCount) return
    logJev({
      timestamp: new Date().toISOString(),
      purpose: 'tool-observation',
      taskId: task.request.id,
      attempt,
      provider: task.request.provider,
      selection: policy.selection.kind,
      used: observation.used,
      violations: observation.violations,
      unknownCount: observation.unknownCount
    })
  }

  /** Plan mode never validates — it only recognizes the finished-plan marker. */
  private finishPlanCycleAttempt(task: Task, attempt: number, scan: CycleScan): CycleAttemptResult {
    if (isFinishedPlan(scan.assistant)) {
      return this.completeCycle(task, attempt, 'Plan ready to execute')
    }
    const marker = parsePipelineIds(scan.control)
    if ('error' in marker) {
      return {
        kind: 'retry',
        opening: continued(
          `End this Plan response with ${FINISHED_PLAN}, ${QUESTIONS_MARKER} if you need a decision, or ${PIPELINES_MARKER} [] when it is not yet a finished plan.`
        )
      }
    }
    return this.completeCycle(task, attempt, 'Plan response complete')
  }

  /**
   * The current provider/model gets `SAME_MODEL_RETRIES` extra tries after a
   * provider-side error before the fallback chain is consulted. A queued
   * user message takes priority over an automatic retry — returning false
   * here lets `finishOrContinue` drain it instead of silently retrying.
   * Every attempt is logged to disk and waits out a backoff delay first, so
   * a rate limit is not immediately hammered again.
   */
  private async shouldRetryAfterError(task: Task, attempt: number, reason: string): Promise<boolean> {
    if (!task.guidance.length) {
      task.sameModelAttempts += 1
      if (task.sameModelAttempts <= SAME_MODEL_RETRIES) {
        this.status(
          task,
          'working',
          attempt,
          `${reason} — retrying with ${aiSelectionLabel(task.request.provider, task.request.model)} (${task.sameModelAttempts}/${SAME_MODEL_RETRIES})`
        )
        logAgentFailure({
          ts: Date.now(),
          taskId: task.request.id,
          attempt,
          provider: task.request.provider,
          model: task.request.model,
          reason,
          outcome: 'retry-same-model',
          sameModelAttempt: task.sameModelAttempts
        })
        await backoffWait(task.sameModelAttempts, task.abort.signal)
        return true
      }
    }
    task.sameModelAttempts = 0
    return this.switchToFallback(task, attempt, reason)
  }

  /**
   * Step down the mode's fallback chain once the same-model retry budget is
   * spent — a missing CLI, a non-zero exit, or a quota/auth banner. The
   * agent's own FAROL_BLOCKED is excluded: that is a judgement about the
   * task, and every other model would reach it too. Returns false once the
   * chain is spent.
   */
  private async switchToFallback(task: Task, attempt: number, reason: string): Promise<boolean> {
    const next = task.fallbacks.shift()
    if (!next) {
      logAgentFailure({
        ts: Date.now(),
        taskId: task.request.id,
        attempt,
        provider: task.request.provider,
        model: task.request.model,
        reason,
        outcome: 'exhausted'
      })
      return false
    }
    const from = aiSelectionLabel(task.request.provider, task.request.model)
    task.request.provider = next.agent
    task.request.model = normalizeModel(next.model)
    task.request.mode = normalizeMode(task.request.mode)
    logAgentFailure({
      ts: Date.now(),
      taskId: task.request.id,
      attempt,
      provider: next.agent,
      model: task.request.model,
      reason,
      outcome: 'fallback',
      from
    })
    this.emit({
      kind: 'provider',
      taskId: task.request.id,
      provider: task.request.provider,
      model: task.request.model,
      mode: task.request.mode,
      reason: `${from} failed (${reason}) — retrying with ${aiSelectionLabel(next.agent, next.model)}.`
    })
    await backoffWait(1, task.abort.signal)
    return true
  }

  /**
   * Questions reach us either scanned from the stream or as a marker in the
   * final text. Returns null when the turn asked nothing.
   */
  private questionsAfterRun(
    task: Task,
    attempt: number,
    scan: CycleScan
  ): CycleAttemptResult | null {
    const marked = scan.questions ? null : parseQuestionsMarker(scan.control)
    if (marked && 'error' in marked) {
      return {
        kind: 'retry',
        opening: continued(`Farol could not show your questions because ${marked.error}`)
      }
    }
    const questions = scan.questions ?? (marked && 'questions' in marked ? marked.questions : undefined)
    if (!questions?.length) return null
    this.pauseForQuestions(task, attempt, questions, scan.questionId)
    return { kind: 'done' }
  }

  private async cycleAfterRun(
    task: Task,
    attempt: number,
    scan: CycleScan,
    code: number,
    opening: Opening
  ): Promise<CycleAttemptResult> {
    if (task.cancelled) {
      this.settleCancel(task)
      return { kind: 'done' }
    }
    flushControlLines(scan)
    await this.applyTodos(task, scan.control)
    this.applyHandoff(task, scan.control)
    const asked = this.questionsAfterRun(task, attempt, scan)
    if (asked) return asked
    // Agent prose can quote a provider banner (a plan about retries, say), so the
    // full output counts only once the run has failed.
    const exitReason = code !== 0 && !scan.blocked ? providerFailure(scan.output) : null
    if (exitReason) {
      scan.blocked = exitReason
      scan.blockedByProvider = true
    }
    if (this.abandonResume(task, scan, code)) return { kind: 'retry', opening, rewindAttempt: true }
    if (scan.blocked) {
      // Same model first (up to SAME_MODEL_RETRIES), then the next rung down
      // the chain — nothing was produced to repair, so the attempt counter
      // does not move either way.
      if (scan.blockedByProvider && (await this.shouldRetryAfterError(task, attempt, scan.blocked))) {
        return { kind: 'retry', opening, rewindAttempt: true }
      }
      // A follow-up may already be queued with a switched provider (e.g. after
      // a usage limit). Surface the stop, then continue that message.
      this.finishOrContinue(task, attempt, 'needs-attention', `Agent stopped: ${scan.blocked}`)
      return { kind: 'done' }
    }
    if (code !== 0) {
      if (await this.shouldRetryAfterError(task, attempt, `exit code ${code}`)) {
        return { kind: 'retry', opening, rewindAttempt: true }
      }
      this.finishOrContinue(task, attempt, 'needs-attention', `Agent exited with code ${code}`)
      return { kind: 'done' }
    }
    task.sameModelAttempts = 0
    if (task.guidance.length) {
      const guidance = task.guidance.splice(0).join('\n')
      return {
        kind: 'retry',
        rewindAttempt: true,
        opening: continued(`Additional user guidance:\n${guidance}`)
      }
    }
    return this.finishCycleAttempt(task, attempt, scan)
  }

  private async runCycleAttempt(
    task: Task,
    opening: Opening,
    attempt: number
  ): Promise<CycleAttemptResult> {
    this.status(
      task,
      attempt === 1 ? 'working' : 'repairing',
      attempt,
      attempt === 1 ? 'Agent working' : 'Agent repairing validation failures'
    )
    // Decided per run: a fallback or a provider switch since the opening was
    // chosen means this CLI has no session and needs the rebuilt history.
    const resume = resumableSession(task.context, cliFor(task.request.provider, openRouterAgent()), task.request.cwd)
    const prompt = this.prompt(task, opening, resume !== undefined)
    // What the agent said, which is what the markers are read from, and
    // everything it printed, which is where provider failures show up.
    const scan: CycleScan = {
      resumed: resume !== undefined,
      assistant: '',
      buffer: '',
      fenced: false,
      control: '',
      output: '',
      noise: '',
      blocked: null,
      blockedByProvider: false,
      shellInvocations: [],
      filesChanged: false,
      changedTargets: [],
      toolNames: []
    }
    const policy = await this.resolveToolPolicy(task, opening.text, attempt)
    task.runAutoApproves = this.autoApproves(task, task.request.provider)
    this.setGate(task, PARENT_GATE, task.request.provider)
    const clause = toolPolicyPrompt(policy)
    const effective = clause ? `${prompt}\n\n${clause}` : prompt
    const sink = this.cycleSink(task, scan)
    task.activeScan = scan
    const epoch = task.askEpoch
    const before = task.turnBefore ?? (await this.turnCapture(task))?.tree
    task.turnBefore = undefined
    const { provider, model } = task.request
    const session: AgentSessionIo = {
      ...(resume ? { resume } : {}),
      onSession: (id) => this.recordSession(task, provider, id),
      onUsage: (usage) => this.recordUsage(task, provider, model, usage)
    }
    const code = this.executor
      ? await this.executor(task.request, effective, sink.text, sink.tool, session)
      : await this.runAgent(task, effective, sink, false, {
          tools: policy.nativeTools,
          webSearch: policy.allowed.includes('web'),
          session
        })
    this.observeTools(task, policy, scan.toolNames, attempt)
    if (task.askEpoch !== epoch) return { kind: 'done' }
    await this.noteTreeChange(task, scan, before)
    return await this.cycleAfterRun(task, attempt, scan, code, opening)
  }

  /** The working copy at the start or end of a Build turn; undefined in Plan mode or outside git. */
  private async turnCapture(task: Task): Promise<Capture | undefined> {
    if (task.request.mode === 'plan') return undefined
    return captureLimited(task.request.cwd, CHECKPOINT_MAX_FILE_BYTES).catch(() => undefined)
  }

  /**
   * A turn that changed the working copy, however it wrote — an edit tool, `sed -i`, a formatter —
   * changed files: mandatory pipelines must run, and Jev sees the changed paths.
   */
  private async noteTreeChange(task: Task, scan: CycleScan, before: string | undefined): Promise<void> {
    if (!before) return
    const cwd = task.request.cwd
    const after = (await this.turnCapture(task))?.tree
    if (!after || !turnChangedFiles(false, before, after)) return
    scan.filesChanged = true
    task.mandatoryOutstanding = true
    for (const target of await changedPaths(cwd, before, after).catch(() => [])) {
      if (!scan.changedTargets.includes(target)) scan.changedTargets.push(target)
    }
  }

  private handleCycleError(task: Task, attempt: number, error: unknown): void {
    if (task.cancelled) {
      this.settleCancel(task)
      return
    }
    task.running = false
    if (task.process?.pid) killPidTree(task.process.pid)
    if (task.child?.pid) killPidTree(task.child.pid)
    this.expireApprovals(task)
    this.status(
      task,
      'failed',
      attempt,
      `Agent stopped: ${errorMessage(error)}`
    )
    this.releaseIfDisposed(task)
  }

  /** One user message: checkpoint the files before it runs and after it ends, around the attempts. */
  private async cycle(task: Task, first: Opening): Promise<void> {
    const before = await this.turnCapture(task)
    task.turnBefore = before?.tree
    const record = before ? startTurn(task.request.cwd, task.request.id, before, turnPreview(first.text)) : undefined
    void record?.started.then(() => this.emit({ kind: 'turns', taskId: task.request.id }))
    try {
      await this.runAttempts(task, first)
    } finally {
      task.turnBefore = undefined
      if (record) void this.endTurn(task, record)
    }
  }

  /** Off the agent's path: the end snapshot and the writes happen after the chat has moved on. */
  private async endTurn(task: Task, record: TurnRecord): Promise<void> {
    const after = await this.turnCapture(task)
    // A cleared chat has released its checkpoints; writing now would bring them back.
    if (task.disposeWhenIdle) return
    await record.finish(after, task.request.checkpointLimit)
    this.emit({ kind: 'turns', taskId: task.request.id })
  }

  private async runAttempts(task: Task, first: Opening): Promise<void> {
    const maxAttempts = Math.max(1, Math.min(20, task.request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS))
    let opening = first
    let attempt = 0
    task.resumeAbandoned = false
    // Fresh cycle → fresh tool ask; within the cycle, same-attempt retries remap.
    task.toolSelection = undefined
    task.toolSelectionAttempt = undefined
    try {
      for (attempt = 1; attempt <= maxAttempts && !task.cancelled; attempt++) {
        await this.loadTodos(task)
        await this.loadCustomInstructions(task)
        const result = await this.runCycleAttempt(task, opening, attempt)
        if (result.kind === 'done') return
        opening = result.opening
        if (result.rewindAttempt) attempt--
      }

      if (task.cancelled) {
        this.settleCancel(task)
        return
      }
      task.running = false
      this.status(task, 'needs-attention', maxAttempts, `Validation still fails after ${maxAttempts} attempts`)
      this.releaseIfDisposed(task)
    } catch (error) {
      this.handleCycleError(task, attempt, error)
    }
  }

  /**
   * The turn's opening, preceded by the chat so far unless the CLI resumes its
   * own session, which already holds it (and every reply and tool result).
   */
  private lead(task: Task, opening: Opening, resuming: boolean): string {
    if (!opening.continued || resuming) return opening.text
    const handoff = task.context.handoff
    return [
      `Continue the original task: ${task.request.prompt}`,
      handoff ? `Handoff note from the agent that worked on this chat before you:\n${handoff}` : '',
      opening.text
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  private prompt(task: Task, opening: Opening, resuming: boolean): string {
    const plan = task.request.mode === 'plan'
    const mandatoryIds = mandatoryPipelines(task.request.pipelines).map((pipeline) => pipeline.id)
    const mandatoryNote = mandatoryIds.length
      ? `Mandatory pipelines (run only when files change, and after a failed mandatory run until they pass): ${mandatoryIds.join(', ')}. ${PIPELINES_MARKER} [] is only valid when you made no file changes and no mandatory pipeline is still waiting to pass.`
      : ''
    return [
      this.lead(task, opening, resuming),
      task.customInstructions ? `\n${task.customInstructions}` : '',
      '',
      `Work only in ${task.request.cwd}.`,
      this.pipelineHistory(task),
      `When you need a decision from the user, ask with ${QUESTIONS_MARKER} followed by a JSON array of questions on one line, and do not include ${PIPELINES_MARKER} on that turn. Each question: { "question": "complete question", "header": "short label", "options": [{ "label": "1-5 words", "description": "what this choice means" }], "multiple": false }. \`multiple: true\` allows more than one option. A custom free-text option is always offered — do not add "Other". Farol shows the questions in Chat and sends the answers back to you.`,
      plan
        ? `Plan mode is read-only. You may inspect the project, ask clarifying questions, and propose a plan, but must not change project files or modify external systems. A finished plan ends with exactly one final line: ${FINISHED_PLAN}. If you need a decision, end with ${QUESTIONS_MARKER}. For an ordinary non-final response, end with ${PIPELINES_MARKER} []. Do not emit ${FINISHED_PLAN} until the plan is complete and ready for the developer to execute. Farol will never run pipelines from a Plan response.`
        : `When the requested file change is complete, select every relevant validation pipeline from the catalog below. If you made no file changes, select none (\`[]\`). Farol will run your selections and return any failures for you to repair.`,
      plan ? '' : mandatoryNote,
      this.todoContext(task),
      `Handoff note: another agent may take the next turn of this chat without seeing this conversation. When the work's state changed this turn, put one line ${HANDOFF_MARKER} "<JSON string>" just before your final marker: what is done, decisions made, dead ends, and the next step, in at most ${MAX_HANDOFF_CHARS} characters. It replaces the previous note; omit it when nothing changed.`,
      plan
        ? `Do not run validation pipelines in Plan mode.`
        : `Never run the catalog's shell commands yourself (lint, typecheck, tests, build, git push, or any other step cmd listed below). Always select pipelines via ${PIPELINES_MARKER} and let Farol execute them — including after a repair turn.`,
      `Never call the Farol MCP pipeline tools (list_pipelines, run_pipeline) in this managed Chat session; select pipelines with ${PIPELINES_MARKER} and the harness runs them. Other MCP tools available to you may be used.`,
      `When you propose or complete a change, include a Mermaid diagram in a \`\`\`mermaid fenced block so Chat can render it. Prefer flowchart TD or sequenceDiagram with 4–12 well-defined steps — detailed but not crowded. In Plan mode, diagram the intended approach. After changing files in Build mode, diagram what changed and why. Keep node labels short; put extra detail in the surrounding prose. Skip a diagram for questions-only or status-only replies.`,
      plan
        ? `End every response with exactly one final line: ${QUESTIONS_MARKER} [...] when you need a decision, ${FINISHED_PLAN} when the plan is complete, or ${PIPELINES_MARKER} [] for an ordinary response.`
        : `End every response with exactly one final line: either ${QUESTIONS_MARKER} [...] when you need a user decision, or ${PIPELINES_MARKER} ["pipeline-id"] when the file-change work for this turn is done — ${PIPELINES_MARKER} [] if no validation is needed. Use a JSON array and only catalog ids for pipelines.`,
      '',
      plan ? '' : `Available Farol pipelines:\n${pipelineCatalog(task.request.pipelines)}`,
      `If a block or error prevents you from completing the task, stop immediately and end your response with “${BLOCK_MARKER} <reason>”. Do not keep trying.`
    ]
      .filter(Boolean)
      .join('\n')
  }

  private todoContext(task: Task): string {
    return (
      `Todo list (shared by every chat in this checkout): put one line ` +
      `${TODOS_MARKER} [{"content":"...","status":"pending|in_progress|completed|cancelled","priority":"high|medium|low"}] ` +
      `just before your final marker to replace the whole list, or ${TODOS_MARKER} [] to clear it. ` +
      `Keep exactly one todo in_progress while work remains.\n${formatTodos(task.todos)}`
    )
  }

  private pipelineHistory(task: Task): string {
    if (!task.pipelineRuns.length) return ''
    const lines = task.pipelineRuns.map((run) => {
      const started = new Date(run.startedAt).toISOString()
      if (run.status === 'running') {
        return `- ${run.pipelineName} (${run.pipelineId}) started at ${started}; status RUNNING.`
      }
      const finished = new Date(run.finishedAt ?? run.startedAt).toISOString()
      const duration = run.durationMs === undefined ? '' : `; duration ${run.durationMs}ms`
      const runId = run.runId ? `; run id ${run.runId}` : ''
      return `- ${run.pipelineName} (${run.pipelineId}) started at ${started}; finished at ${finished}; status ${run.status.toUpperCase()}${duration}${runId}.`
    })
    return `Farol pipeline activity for this chat:\n${lines.join('\n')}`
  }

  /**
   * A run over ACP (OpenCode): Farol's managed server rides in the session,
   * and permission requests go to the developer, or are answered by
   * auto-approve. Plan answers every request with no: its run config already
   * denies shell, and nothing in Plan should need permission.
   */
  private async runAcpAgent(
    task: Task,
    prompt: string,
    sink: AgentSink,
    opts: Parameters<AgentController['runAgent']>[4]
  ): Promise<number> {
    const via = openRouterAgent()
    const child = opts?.child
    const provider = child?.provider ?? task.request.provider
    const model = child ? child.model : task.request.model
    const cli = cliFor(provider, via)
    const bin = resolveBinFrom([cli])
    if (!bin) {
      sink.text(`farol: ${managedAiCommand(provider, prompt, model, { via }).hint}\n`)
      return 127
    }
    const plan = task.request.mode === 'plan'
    const askFirst = !this.autoApproves(task, provider)
    const env = aiEnv(provider, via)
    // Subagents get no managed server, so they cannot delegate in turn; ACP asks for approval itself.
    const mcp = this.managed && !child ? this.managed.mcp(task.request.id, undefined, ['delegate']) : undefined
    applyOpencodeConfig(env, opencodeRunConfig(plan ? 'plan' : 'build', askFirst, !!mcp))
    const result = await runAcp({
      bin,
      args: ['acp'],
      cwd: task.request.cwd,
      env,
      prompt,
      mode: plan ? 'plan' : 'build',
      ...(model ? { model: provider === 'openrouter' ? openCodeModel(model) : model } : {}),
      ...(opts?.session?.resume ? { resume: opts.session.resume } : {}),
      mcpServers: mcp ? [acpMcpServer(MANAGED_MCP_SERVER_KEY, mcp)] : [],
      permission: this.acpPermission(task, plan, askFirst, child?.delegateId),
      ...this.acpCallbacks(task, sink, opts, !!child)
    })
    if (result.unsupported && !task.cancelled) return this.runAgent(task, prompt, sink, false, { ...opts, noAcp: true })
    return result.code
  }

  /** Answers the agent's permission requests: no in Plan, yes under auto-approve, otherwise the developer decides. */
  private acpPermission(task: Task, plan: boolean, askFirst: boolean, delegateId: string | undefined) {
    return async (call: Parameters<typeof acpApprovalAsk>[0]): Promise<boolean> => {
      if (plan) return false
      if (!askFirst) return true
      const answer = await this.requestApproval(task.request.id, {
        ...acpApprovalAsk(call),
        ...(delegateId ? { delegateId } : {})
      })
      return answer.allow
    }
  }

  /** Passes an ACP run's output, session, usage and process on to the chat. */
  private acpCallbacks(task: Task, sink: AgentSink, opts: Parameters<AgentController['runAgent']>[4], child: boolean) {
    return {
      onText: (chunk: string) => sink.text(chunk),
      onTool: (event: Parameters<AgentSink['tool']>[0]) => sink.tool(event),
      onNoise: (chunk: string) => sink.noise(chunk),
      onSession: (id: string) => opts?.session?.onSession(id),
      onUsage: (tokens: number) => opts?.session?.onUsage?.({ tokens }),
      onProcess: (proc: ChildProcess | null) => this.setProcess(task, child, proc)
    }
  }

  private setProcess(task: Task, child: boolean, proc: ChildProcess | null): void {
    if (child) task.child = proc
    else task.process = proc
  }

  /** The CLI command and environment for a managed run: tools, Farol's server, approvals and mode. */
  private agentCommand(
    task: Task,
    prompt: string,
    plain: boolean,
    opts: Parameters<AgentController['runAgent']>[4],
    who: { provider: AiProvider; model: string | undefined; via: ReturnType<typeof openRouterAgent> }
  ) {
    const { provider, model, via } = who
    const child = opts?.child
    const askApproval = !this.autoApproves(task, provider)
    const tools = managedToolsFor({ subagent: !!child, claudeAsks: askApproval && provider === 'claude' })
    // A server with no tools shows up as broken, so a run with nothing to offer gets none.
    const mcp = this.managed && tools.length ? this.managed.mcp(task.request.id, child?.delegateId, tools) : undefined
    const codexHook = askApproval ? this.managed?.codexHook?.(task.request.id, child?.delegateId) : undefined
    const spec = managedAiCommand(provider, prompt, model, {
      jsonFormat: !plain,
      via,
      mode: task.request.mode,
      ...commandExtras(opts, { mcp, askApproval, codexHook })
    })
    const env = aiEnv(provider, via)
    applyOpencodeConfig(env, spec.opencodeConfig)
    // Claude's limit on one MCP call; a `delegate` waits as long as its subagent runs.
    if (mcp) env.MCP_TOOL_TIMEOUT = String(MANAGED_TOOL_TIMEOUT_SEC * 1000)
    return { spec, env }
  }

  private runAgent(
    task: Task,
    prompt: string,
    sink: AgentSink,
    plain = false,
    opts?: {
      tools?: string[]
      webSearch?: boolean
      session?: AgentSessionIo
      /** Run a subagent with this provider/model instead of the task's own agent. */
      child?: { provider: AiProvider; model?: string; delegateId: string }
      /** The CLI turned out not to speak ACP; use its JSON mode. */
      noAcp?: boolean
    }
  ): Promise<number> {
    if (task.cancelled) return Promise.resolve(1)
    const via = openRouterAgent()
    const child = opts?.child
    const provider = child?.provider ?? task.request.provider
    const model = child ? child.model : task.request.model
    if (!plain && !opts?.noAcp && ACP_CLIS.includes(cliFor(provider, via))) {
      return this.runAcpAgent(task, prompt, sink, opts)
    }
    const isChild = !!child
    const { spec, env } = this.agentCommand(task, prompt, plain, opts, { provider, model, via })
    const bin = resolveBinFrom(spec.bins)
    if (!bin) {
      sink.text(`farol: ${spec.hint}\n`)
      return Promise.resolve(127)
    }

    // A streaming provider keeps its diagnostics out of the transcript, so
    // hold on to the tail and show it if the run turns out to have failed.
    const parser = spec.stream === 'ndjson' ? new AgentStreamParser() : null
    let diagnostics = ''
    let stdoutScan = ''
    // Chunks split wherever the pipe fills, including mid-character.
    const stdoutText = new StringDecoder('utf8')
    const stderrText = new StringDecoder('utf8')

    const consume = streamConsumer(parser, sink, opts?.session?.onUsage)

    return new Promise((resolve) => {
      let settled = false
      const done = (exit: number): void => {
        if (settled) return
        settled = true
        this.setProcess(task, isChild, null)
        let code = exit
        if (parser) {
          consume(parser.flush())
          if (code === 0 && parser.failed) code = 1
          if (parser.sessionId) opts?.session?.onSession(parser.sessionId)
          const tail = diagnostics.trim()
          if (code !== 0 && tail) sink.text(`${tail.slice(-SCAN_WINDOW)}\n`)
        }
        resolve(code)
      }
      let child: ChildProcess
      try {
        child = spawn(bin, spec.args, {
          cwd: task.request.cwd,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (error) {
        sink.text(`farol: ${errorMessage(error)}\n`)
        done(127)
        return
      }
      this.setProcess(task, isChild, child)
      child.stdout?.on('data', (chunk: Buffer) => {
        // JSON carries its own escaping, and plainText's per-line trimming
        // would eat a space that straddles two chunks. Parse the bytes as-is.
        const text = stdoutText.write(chunk)
        if (parser) {
          stdoutScan = (stdoutScan + text).slice(-SCAN_WINDOW)
          consume(parser.push(text))
        } else {
          sink.text(plainText(text))
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = plainText(stderrText.write(chunk))
        if (!parser) {
          sink.text(text)
          return
        }
        diagnostics = (diagnostics + text).slice(-SCAN_WINDOW)
        sink.noise(text)
      })
      child.on('error', (error) => {
        sink.text(`farol: ${error.message}\n`)
        done(127)
      })
      child.on('close', (code) => {
        const exit = code ?? 127
        if (
          !settled &&
          !task.cancelled &&
          shouldRetryPlainOpenCode(plain, exit, provider, `${diagnostics}\n${stdoutScan}`)
        ) {
          settled = true
          this.setProcess(task, isChild, null)
          void this.runAgent(task, prompt, sink, true, opts).then(resolve)
          return
        }
        done(exit)
      })
    })
  }
}
