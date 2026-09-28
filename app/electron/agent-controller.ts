import { spawn, type ChildProcess } from 'child_process'
import { StringDecoder } from 'string_decoder'
import type {
  AgentTaskEvent,
  AgentTaskRequest,
  AgentTaskStatus,
  AiProvider,
  ModelChoice,
  Pipeline,
  PipelineRunResult
} from '../shared/types'
import {
  aiSelectionLabel,
  cliFor,
  isAiProvider,
  isUnknownJsonFormatError,
  managedAiCommand,
  normalizeAi,
  normalizeMode,
  normalizeModel
} from '../shared/ai'
import { AgentStreamParser } from '../shared/agent-stream'
import { appendControlLines, flushControlLines, lastControlLine, type ControlLineState } from '../shared/control-line'
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
import {
  isWriteToolName,
  mandatoryOptOutError,
  mandatoryPipelines,
  mergeWithMandatory
} from '../shared/mandatory'
import { pipelineSelectionState } from '../shared/jev'
import { plainText } from '../shared/terminal'
import { aiEnv, resolveBinFrom } from './bin'
import { killPidTree } from './kill'
import { selectPipelines } from './jev'

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

export type AgentExecutor = (
  request: AgentTaskRequest,
  prompt: string,
  onOutput: (chunk: string) => void,
  onTool?: (event: AgentToolReport) => void
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
  running: boolean
  cancelled: boolean
  /** Drop from the map once the in-flight cycle settles (cleared chats). */
  disposeWhenIdle: boolean
  guidance: string[]
  pipelineRuns: PipelineActivity[]
  todos: Todo[]
  abort: AbortController
  /** Set on file writes / failed mandatory runs; cleared when they pass. */
  mandatoryOutstanding: boolean
  /** Rungs of the mode's chain not yet tried; refilled when a turn begins. */
  fallbacks: ModelChoice[]
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
  assistant: string
  output: string
  blocked: string | null
  /** The stop came from the CLI itself (quota, auth, context), not the agent. */
  blockedByProvider: boolean
  shellInvocations: string[]
  filesChanged: boolean
  /** Paths or targets reported by completed write tools this turn. */
  changedTargets: string[]
  questions?: AgentQuestion[]
  questionId?: string
}

type CycleAttemptResult =
  | { kind: 'done' }
  | { kind: 'retry'; opening: string; rewindAttempt?: boolean }
  | { kind: 'retry'; prompt: string; rewindAttempt: true }

const DEFAULT_MAX_ATTEMPTS = 5
/** How much trailing output the marker and failure scans keep in memory. */
const SCAN_WINDOW = 16_384
/** Cap stored prompt history so long chats cannot retain unbounded text. */
const MAX_PROMPT_CHARS = 100_000
/** Cap pipeline activity retained for prompt context. */
const MAX_PIPELINE_RUNS = 40

function shouldRetryPlainOpenCode(
  plain: boolean,
  exit: number,
  provider: AiProvider,
  diagnostics: string
): boolean {
  return !plain && exit !== 0 && cliFor(provider) === 'opencode' && isUnknownJsonFormatError(diagnostics)
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

/**
 * Provider-level failures that cannot be repaired inside the task (usage /
 * session / auth / quota / context banners from the coding CLI). Keep this
 * narrow: generic OS/HTTP phrases like "permission denied" or "forbidden" show
 * up in ordinary tool stderr and must not abort the chat.
 */
function providerFailure(output: string): string | null {
  const match =
    /(?:authentication failed|not authenticated|rate[ _-]limit(?:ed|[ _-]?error|\s+(?:exceeded|reached))?|429(?:\s|$)|(?:usage|session) limit|quota exceeded|insufficient (?:credits|quota)|maximum context length|context length exceeded)/i.exec(
      output
    )
  return match ? match[0] : null
}

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
  originalPrompt: string,
  attempt: number,
  failures: { pipeline: Pipeline; result: PipelineRunResult }[],
  guidance: string
): string {
  return [
    `Continue the original task: ${originalPrompt}`,
    '',
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
        (pipeline.target === 'vercel' ? ' [remote: Vercel Sandbox]' : '')
      const steps = pipeline.nodes
        .map((node) => {
          const model = normalizeModel(node.model)
          const kind =
            node.type === 'ai'
              ? `ai/${normalizeAi(node.ai)}${model ? `/${model}` : ''}`
              : node.type
          return `  - ${node.name || node.id} (${kind}): ${node.cmd}`
        })
        .join('\n')
      return `- ${pipeline.name} [id: ${pipeline.id}]${tag}\n${steps}`
    })
    .join('\n')
}

export class AgentController {
  private tasks = new Map<string, Task>()

  constructor(
    private runner: ValidationRunner,
    private emit: (event: AgentTaskEvent) => void,
    private executor?: AgentExecutor,
    private todoStore?: TodoStore
  ) {}

  start(request: AgentTaskRequest): { ok: boolean; message?: string } {
    const clean = request.prompt.trim()
    const mode = normalizeMode(request.mode, request.provider)
    if (!clean) return { ok: false, message: 'Enter a task for the agent.' }
    const existing = this.tasks.get(request.id)
    if (existing) {
      if (existing.running) return { ok: false, message: 'An agent task with this id is already running.' }
      existing.request = {
        ...existing.request,
        ...request,
        prompt: existing.request.prompt,
        mode,
        pipelines: request.pipelines.filter((pipeline) => pipeline.nodes.length)
      }
      existing.fallbacks = [...(request.fallbacks ?? [])]
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
      running: true,
      cancelled: false,
      disposeWhenIdle: false,
      guidance: [],
      pipelineRuns: [],
      todos: [],
      abort: new AbortController(),
      mandatoryOutstanding: false,
      fallbacks: [...(request.fallbacks ?? [])],
      askEpoch: 0,
      questionSeq: 0,
      todoSeq: 0
    }
    this.tasks.set(request.id, task)
    this.emit({ kind: 'user', taskId: request.id, text: clean })
    void this.cycle(task, clean)
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
    }
    if (fallbacks) task.fallbacks = [...fallbacks]
    task.request.mode = normalizeMode(mode ?? task.request.mode, task.request.provider)
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
    task.request.mode = normalizeMode(mode ?? task.request.mode, provider)
    return { ok: true }
  }

  cancel(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.cancelled = true
    task.pendingQuestions = undefined
    task.abort.abort()
    if (task.process?.pid) killPidTree(task.process.pid)
    this.status(task, 'cancelled', 0, 'Cancelled by user')
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
   * Cancel and release the task. Cleared/closed chats must not leave prompt
   * history and pipeline catalogs resident for the rest of the session.
   */
  dispose(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.disposeWhenIdle = true
    task.guidance.length = 0
    this.cancel(taskId)
    if (!task.running) this.tasks.delete(taskId)
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

  /** Append a user follow-up and start a new cycle with the full task history. */
  private followUp(task: Task, userText: string): void {
    task.askEpoch += 1
    const next = `${task.request.prompt}\n\nFollow-up: ${userText}`
    task.request.prompt = next.length > MAX_PROMPT_CHARS ? next.slice(-MAX_PROMPT_CHARS) : next
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
    void this.cycle(
      task,
      `Continue the original task: ${task.request.prompt}\n\nUser request: ${userText}`
    )
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
  private continueIfGuidanceOpening(task: Task): string | null {
    const guidance = task.guidance.splice(0).join('\n')
    if (!guidance) return null
    return `Continue the original task: ${task.request.prompt}\n\nUser request:\n${guidance}`
  }

  private cycleSink(task: Task, scan: CycleScan): AgentSink {
    const check = (): void => {
      const agentStop = blockedMarker(scan.assistant)
      const reason = agentStop ?? providerFailure(scan.output)
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
        this.emit({ kind: 'tool', taskId: task.request.id, ...event })
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
        check()
      }
    }
  }

  private async loadTodos(task: Task): Promise<void> {
    if (!this.todoStore) return
    task.todos = await this.todoStore.load(task.request.checkout).catch(() => task.todos)
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

  /** Pick pipelines from the agent's marker and run them, or retry if invalid. */
  private async finishCycleAttempt(
    task: Task,
    attempt: number,
    scan: CycleScan
  ): Promise<CycleAttemptResult> {
    if (task.request.mode === 'plan') return this.finishPlanCycleAttempt(task, attempt, scan)
    const selection = selectedPipelines(scan.control, task.request.pipelines)
    const retryInvalid = (reason: string): CycleAttemptResult => ({
      kind: 'retry',
      opening: `Continue the original task: ${task.request.prompt}\n\nFarol could not validate because ${reason}`
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
      opening: repairPromptOpening(task.request.prompt, attempt, outcome.failures, guidance)
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

  /** Plan mode never validates — it only recognizes the finished-plan marker. */
  private finishPlanCycleAttempt(task: Task, attempt: number, scan: CycleScan): CycleAttemptResult {
    if (isFinishedPlan(scan.assistant)) {
      return this.completeCycle(task, attempt, 'Plan ready to execute')
    }
    const marker = parsePipelineIds(scan.control)
    if ('error' in marker) {
      return {
        kind: 'retry',
        opening: `Continue the original task: ${task.request.prompt}\n\nEnd this Plan response with ${FINISHED_PLAN}, ${QUESTIONS_MARKER} if you need a decision, or ${PIPELINES_MARKER} [] when it is not yet a finished plan.`
      }
    }
    return this.completeCycle(task, attempt, 'Plan response complete')
  }

  /**
   * Step down the mode's fallback chain after a provider-side failure — a
   * missing CLI, a non-zero exit, or a quota/auth banner. The agent's own
   * FAROL_BLOCKED is excluded: that is a judgement about the task, and every
   * other model would reach it too. Returns false once the chain is spent.
   */
  private switchToFallback(task: Task, reason: string): boolean {
    const next = task.fallbacks.shift()
    if (!next) return false
    const from = aiSelectionLabel(task.request.provider, task.request.model)
    task.request.provider = next.agent
    task.request.model = normalizeModel(next.model)
    task.request.mode = normalizeMode(task.request.mode, next.agent)
    this.emit({
      kind: 'provider',
      taskId: task.request.id,
      provider: task.request.provider,
      model: task.request.model,
      mode: task.request.mode,
      reason: `${from} failed (${reason}) — retrying with ${aiSelectionLabel(next.agent, next.model)}.`
    })
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
        opening: `Continue the original task: ${task.request.prompt}\n\nFarol could not show your questions because ${marked.error}`
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
    prompt: string
  ): Promise<CycleAttemptResult> {
    if (task.cancelled) {
      this.settleCancel(task)
      return { kind: 'done' }
    }
    flushControlLines(scan)
    await this.applyTodos(task, scan.control)
    const asked = this.questionsAfterRun(task, attempt, scan)
    if (asked) return asked
    if (scan.blocked) {
      // The same turn, on the next model down the chain — nothing was produced
      // to repair, so the attempt counter does not move.
      if (scan.blockedByProvider && this.switchToFallback(task, scan.blocked)) {
        return { kind: 'retry', prompt, rewindAttempt: true }
      }
      // A follow-up may already be queued with a switched provider (e.g. after
      // a usage limit). Surface the stop, then continue that message.
      this.finishOrContinue(task, attempt, 'needs-attention', `Agent stopped: ${scan.blocked}`)
      return { kind: 'done' }
    }
    if (code !== 0) {
      if (this.switchToFallback(task, `exit code ${code}`)) {
        return { kind: 'retry', prompt, rewindAttempt: true }
      }
      this.finishOrContinue(task, attempt, 'needs-attention', `Agent exited with code ${code}`)
      return { kind: 'done' }
    }
    if (task.guidance.length) {
      const guidance = task.guidance.splice(0).join('\n')
      return {
        kind: 'retry',
        rewindAttempt: true,
        opening: `Continue the original task: ${task.request.prompt}\n\nAdditional user guidance:\n${guidance}`
      }
    }
    return this.finishCycleAttempt(task, attempt, scan)
  }

  private async runCycleAttempt(
    task: Task,
    prompt: string,
    attempt: number
  ): Promise<CycleAttemptResult> {
    this.status(
      task,
      attempt === 1 ? 'working' : 'repairing',
      attempt,
      attempt === 1 ? 'Agent working' : 'Agent repairing validation failures'
    )
    // What the agent said, which is what the markers are read from, and
    // everything it printed, which is where provider failures show up.
    const scan: CycleScan = {
      assistant: '',
      buffer: '',
      fenced: false,
      control: '',
      output: '',
      blocked: null,
      blockedByProvider: false,
      shellInvocations: [],
      filesChanged: false,
      changedTargets: []
    }
    const sink = this.cycleSink(task, scan)
    const epoch = task.askEpoch
    const code = this.executor
      ? await this.executor(task.request, prompt, sink.text, sink.tool)
      : await this.runAgent(task, prompt, sink)
    if (task.askEpoch !== epoch) return { kind: 'done' }
    return await this.cycleAfterRun(task, attempt, scan, code, prompt)
  }

  private handleCycleError(task: Task, attempt: number, error: unknown): void {
    if (task.cancelled) {
      this.settleCancel(task)
      return
    }
    task.running = false
    if (task.process?.pid) killPidTree(task.process.pid)
    this.status(
      task,
      'failed',
      attempt,
      `Agent stopped: ${error instanceof Error ? error.message : String(error)}`
    )
    this.releaseIfDisposed(task)
  }

  private async cycle(task: Task, opening: string): Promise<void> {
    const maxAttempts = Math.max(1, Math.min(20, task.request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS))
    let openingText = opening
    let prompt: string | undefined
    let attempt = 0
    try {
      for (attempt = 1; attempt <= maxAttempts && !task.cancelled; attempt++) {
        await this.loadTodos(task)
        const currentPrompt = prompt ?? this.prompt(task, openingText)
        prompt = undefined
        const result = await this.runCycleAttempt(task, currentPrompt, attempt)
        if (result.kind === 'done') return
        if ('prompt' in result) prompt = result.prompt
        else openingText = result.opening
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

  private prompt(task: Task, opening: string): string {
    const plan = task.request.mode === 'plan'
    const mandatoryIds = mandatoryPipelines(task.request.pipelines).map((pipeline) => pipeline.id)
    const mandatoryNote = mandatoryIds.length
      ? `Mandatory pipelines (run only when files change, and after a failed mandatory run until they pass): ${mandatoryIds.join(', ')}. ${PIPELINES_MARKER} [] is only valid when you made no file changes and no mandatory pipeline is still waiting to pass.`
      : ''
    return [
      opening,
      '',
      `Work only in ${task.request.cwd}.`,
      this.pipelineHistory(task),
      `When you need a decision from the user, ask with ${QUESTIONS_MARKER} followed by a JSON array of questions on one line, and do not include ${PIPELINES_MARKER} on that turn. Each question: { "question": "complete question", "header": "short label", "options": [{ "label": "1-5 words", "description": "what this choice means" }], "multiple": false }. \`multiple: true\` allows more than one option. A custom free-text option is always offered — do not add "Other". Farol shows the questions in Chat and sends the answers back to you.`,
      plan
        ? `Plan mode is read-only. You may inspect the project, ask clarifying questions, and propose a plan, but must not change project files or modify external systems. A finished plan ends with exactly one final line: ${FINISHED_PLAN}. If you need a decision, end with ${QUESTIONS_MARKER}. For an ordinary non-final response, end with ${PIPELINES_MARKER} []. Do not emit ${FINISHED_PLAN} until the plan is complete and ready for the developer to execute. Farol will never run pipelines from a Plan response.`
        : `When the requested file change is complete, select every relevant validation pipeline from the catalog below. If you made no file changes, select none (\`[]\`). Farol will run your selections and return any failures for you to repair.`,
      plan ? '' : mandatoryNote,
      this.todoContext(task),
      plan
        ? `Do not run validation pipelines in Plan mode.`
        : `Never run the catalog's shell commands yourself (lint, typecheck, tests, build, git push, or any other step cmd listed below). Always select pipelines via ${PIPELINES_MARKER} and let Farol execute them — including after a repair turn.`,
      `Do not call the Farol MCP tools in this managed Chat session. They are not available here — they require approval in some providers, and the managed harness executes your selected pipelines directly.`,
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

  private runAgent(task: Task, prompt: string, sink: AgentSink, plain = false): Promise<number> {
    if (task.cancelled) return Promise.resolve(1)
    const spec = managedAiCommand(task.request.provider, prompt, task.request.model, {
      jsonFormat: !plain,
      mode: task.request.mode
    })
    const env = aiEnv(task.request.provider)
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

    const consume = (events: ReturnType<AgentStreamParser['push']>): void => {
      for (const event of events) {
        if (event.kind === 'text') sink.turn(event.text)
        else if (event.kind === 'raw') sink.text(plainText(event.text))
        else if (event.kind === 'question') sink.question(event.questions)
        else sink.tool(event)
      }
    }

    return new Promise((resolve) => {
      let settled = false
      const done = (code: number): void => {
        if (settled) return
        settled = true
        task.process = null
        if (parser) {
          consume(parser.flush())
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
        sink.text(`farol: ${error instanceof Error ? error.message : String(error)}\n`)
        done(127)
        return
      }
      task.process = child
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
          shouldRetryPlainOpenCode(plain, exit, task.request.provider, `${diagnostics}\n${stdoutScan}`)
        ) {
          settled = true
          task.process = null
          void this.runAgent(task, prompt, sink, true).then(resolve)
          return
        }
        done(exit)
      })
    })
  }
}
