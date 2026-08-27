import { spawn, type ChildProcess } from 'child_process'
import { StringDecoder } from 'string_decoder'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type {
  AgentTaskEvent,
  AgentTaskRequest,
  AgentTaskStatus,
  AiProvider,
  Pipeline,
  PipelineRunResult
} from '../shared/types'
import { isAiProvider, managedAiCommand } from '../shared/ai'
import { AgentStreamParser } from '../shared/agent-stream'
import { plainText } from '../shared/terminal'
import { shellEnv } from './session'
import { killPidTree } from './kill'

interface ValidationRunner {
  run(
    pipeline: Pipeline,
    cwd: string,
    branch: string,
    origin: 'managed-agent',
    signal?: AbortSignal
  ): Promise<PipelineRunResult>
}

export type AgentExecutor = (
  request: AgentTaskRequest,
  prompt: string,
  onOutput: (chunk: string) => void
) => Promise<number>

/**
 * Where one agent invocation reports what it is doing. `text` and `turn` both
 * reach the chat and both count as the agent "speaking" — only they are
 * scanned for BuildFlow's markers. `noise` is diagnostics (stderr, banners):
 * held back from the transcript, but still watched for provider failures.
 */
interface AgentSink {
  /** Streaming prose, appended to the turn in progress. */
  text(chunk: string): void
  /** A complete assistant turn. */
  turn(text: string): void
  tool(event: { toolId: string; name: string; detail?: string; state: 'running' | 'done' | 'error' }): void
  noise(chunk: string): void
}

interface Task {
  request: AgentTaskRequest
  process: ChildProcess | null
  running: boolean
  cancelled: boolean
  guidance: string[]
  pipelineRuns: PipelineActivity[]
  abort: AbortController
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

const DEFAULT_MAX_ATTEMPTS = 5
const BLOCK_MARKER = 'BUILDFLOW_BLOCKED:'
/** How much trailing output the marker and failure scans keep in memory. */
const SCAN_WINDOW = 16_384
const PIPELINES_MARKER = 'BUILDFLOW_PIPELINES:'

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
 * Provider-level failures that cannot be repaired inside the task. These
 * surface on stderr rather than in the transcript, so this reads raw output.
 */
function providerFailure(output: string): string | null {
  const match =
    /(?:authentication failed|not authenticated|permission denied|unauthorized|forbidden|rate limit(?:\s+exceeded)?|(?:usage|session) limit|quota exceeded|insufficient (?:credits|quota)|maximum context length|context length exceeded)/i.exec(
      output
    )
  return match ? match[0] : null
}

function searchPath(): string {
  const env = shellEnv()
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean)
  const home = os.homedir()
  for (const dir of [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.cursor', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin')
  ]) {
    if (!dirs.includes(dir)) dirs.unshift(dir)
  }
  return dirs.join(path.delimiter)
}

function resolveBin(names: string[], search: string): string | null {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const name of names) {
    for (const dir of search.split(path.delimiter)) {
      for (const extension of extensions) {
        const candidate = path.join(dir, name + extension)
        try {
          fs.accessSync(candidate, fs.constants.X_OK)
          return candidate
        } catch {
          // Try the next candidate.
        }
      }
    }
  }
  return null
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

function selectedPipelines(
  output: string,
  available: Pipeline[]
): { pipelines: Pipeline[]; error?: string } {
  const marker = output.lastIndexOf(PIPELINES_MARKER)
  if (marker < 0) {
    return {
      pipelines: [],
      error: `End your response with ${PIPELINES_MARKER} followed by a JSON array of pipeline ids.`
    }
  }

  const raw = output
    .slice(marker + PIPELINES_MARKER.length)
    .split(/\r?\n/, 1)[0]
    .trim()
  let ids: unknown
  try {
    ids = JSON.parse(raw)
  } catch {
    return { pipelines: [], error: `The value after ${PIPELINES_MARKER} must be a JSON array.` }
  }
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    return { pipelines: [], error: `The value after ${PIPELINES_MARKER} must be a JSON array of pipeline id strings.` }
  }

  // An empty array means the agent made no code changes and wants to skip
  // validation — that is intentional, not a parse error.
  if (!ids.length) return { pipelines: [] }

  const byId = new Map(available.map((pipeline) => [pipeline.id, pipeline]))
  const selected: Pipeline[] = []
  const unknown: string[] = []
  for (const id of ids) {
    const pipeline = byId.get(id)
    if (!pipeline) {
      unknown.push(id)
    } else if (!selected.includes(pipeline)) {
      selected.push(pipeline)
    }
  }
  if (unknown.length) {
    return { pipelines: [], error: `Unknown pipeline id${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}` }
  }
  return { pipelines: selected }
}

function pipelineCatalog(pipelines: Pipeline[]): string {
  return pipelines
    .map((pipeline) => {
      const steps = pipeline.nodes
        .map((node) => `  - ${node.name || node.id} (${node.type}): ${node.cmd}`)
        .join('\n')
      return `- ${pipeline.name} [id: ${pipeline.id}]\n${steps}`
    })
    .join('\n')
}

export class AgentController {
  private tasks = new Map<string, Task>()

  constructor(
    private runner: ValidationRunner,
    private emit: (event: AgentTaskEvent) => void,
    private executor?: AgentExecutor
  ) {}

  start(request: AgentTaskRequest): { ok: boolean; message?: string } {
    const clean = request.prompt.trim()
    if (!clean) return { ok: false, message: 'Enter a task for the agent.' }
    const existing = this.tasks.get(request.id)
    if (existing) {
      if (existing.running) return { ok: false, message: 'An agent task with this id is already running.' }
      existing.request = {
        ...existing.request,
        ...request,
        prompt: existing.request.prompt,
        pipelines: request.pipelines.filter((pipeline) => pipeline.nodes.length)
      }
      this.emit({ kind: 'user', taskId: request.id, text: clean })
      this.followUp(existing, clean)
      return { ok: true }
    }
    if (!request.pipelines.some((pipeline) => pipeline.nodes.length)) {
      return { ok: false, message: 'Create a non-empty validation pipeline first.' }
    }
    const task: Task = {
      request: {
        ...request,
        prompt: request.prompt.trim(),
        pipelines: request.pipelines.filter((pipeline) => pipeline.nodes.length)
      },
      process: null,
      running: true,
      cancelled: false,
      guidance: [],
      pipelineRuns: [],
      abort: new AbortController()
    }
    this.tasks.set(request.id, task)
    this.emit({ kind: 'user', taskId: request.id, text: clean })
    void this.cycle(task, clean)
    return { ok: true }
  }

  message(
    taskId: string,
    text: string,
    provider?: AiProvider
  ): { ok: boolean; message?: string } {
    const task = this.tasks.get(taskId)
    const clean = text.trim()
    if (!task) return { ok: false, message: 'This agent task is no longer available.' }
    if (!clean) return { ok: false, message: 'Enter a message.' }
    // A provider switch mid-chat (e.g. after a usage limit) must stick before
    // the next cycle, including when the follow-up is only queued.
    if (isAiProvider(provider)) task.request.provider = provider
    this.emit({ kind: 'user', taskId, text: clean })
    // Stop only aborts the in-flight run. A follow-up message resumes the same
    // chat — queue it if the cancelled cycle is still winding down.
    if (task.running) {
      task.guidance.push(clean)
      return { ok: true }
    }
    this.followUp(task, clean)
    return { ok: true }
  }

  cancel(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.cancelled = true
    task.abort.abort()
    if (task.process?.pid) killPidTree(task.process.pid)
    this.status(task, 'cancelled', 0, 'Cancelled by user')
  }

  cancelAll(): void {
    for (const id of this.tasks.keys()) this.cancel(id)
  }

  private status(task: Task, status: AgentTaskStatus, attempt: number, message: string): void {
    this.emit({ kind: 'status', taskId: task.request.id, status, attempt, message })
  }

  private pipelineStatus(task: Task, activity: PipelineActivity): void {
    this.emit({ kind: 'pipeline', taskId: task.request.id, ...activity })
  }

  /** Append a user follow-up and start a new cycle with the full task history. */
  private followUp(task: Task, userText: string): void {
    task.request.prompt = `${task.request.prompt}\n\nFollow-up: ${userText}`
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
    if (!task.cancelled || !task.guidance.length) return
    const text = task.guidance.splice(0).join('\n')
    this.followUp(task, text)
  }

  /** If the user typed while a cycle was finishing, run their message next. */
  private continueIfGuidance(task: Task): string | null {
    const guidance = task.guidance.splice(0).join('\n')
    if (!guidance) return null
    return this.prompt(
      task,
      `Continue the original task: ${task.request.prompt}\n\nUser request:\n${guidance}`
    )
  }

  private async cycle(task: Task, opening: string): Promise<void> {
    const maxAttempts = Math.max(1, Math.min(20, task.request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS))
    let prompt = this.prompt(task, opening)
    let attempt = 0
    try {
      for (attempt = 1; attempt <= maxAttempts && !task.cancelled; attempt++) {
        this.status(task, attempt === 1 ? 'working' : 'repairing', attempt, attempt === 1 ? 'Agent working' : 'Agent repairing validation failures')
        // What the agent said, which is what the markers are read from, and
        // everything it printed, which is where provider failures show up.
        let assistant = ''
        let output = ''
        let blocked: string | null = null
        const check = (): void => {
          const reason = blockedMarker(assistant) ?? providerFailure(output)
          if (!blocked && reason) {
            blocked = reason
            if (task.process?.pid) killPidTree(task.process.pid)
          }
        }
        const sink: AgentSink = {
          text: (chunk) => {
            this.emit({ kind: 'output', taskId: task.request.id, chunk })
            assistant = (assistant + chunk).slice(-SCAN_WINDOW)
            output = (output + chunk).slice(-SCAN_WINDOW)
            check()
          },
          turn: (text) => {
            this.emit({ kind: 'assistant', taskId: task.request.id, text })
            assistant = (`${assistant}\n${text}`).slice(-SCAN_WINDOW)
            output = (`${output}\n${text}`).slice(-SCAN_WINDOW)
            check()
          },
          tool: (event) => this.emit({ kind: 'tool', taskId: task.request.id, ...event }),
          noise: (chunk) => {
            output = (output + chunk).slice(-SCAN_WINDOW)
            check()
          }
        }
        const code = this.executor
          ? await this.executor(task.request, prompt, sink.text)
          : await this.runAgent(task, prompt, sink)
        if (task.cancelled) {
          this.settleCancel(task)
          return
        }
        if (blocked) {
          // A follow-up may already be queued with a switched provider (e.g. after
          // a usage limit). Surface the stop, then continue that message.
          this.finishOrContinue(
            task,
            attempt,
            'needs-attention',
            `Agent stopped: ${blocked}`
          )
          return
        }
        if (code !== 0) {
          this.finishOrContinue(
            task,
            attempt,
            'needs-attention',
            `Agent exited with code ${code}`
          )
          return
        }
        if (task.guidance.length) {
          const guidance = task.guidance.splice(0).join('\n')
          prompt = this.prompt(
            task,
            `Continue the original task: ${task.request.prompt}\n\nAdditional user guidance:\n${guidance}`
          )
          attempt--
          continue
        }

        const selection = selectedPipelines(assistant, task.request.pipelines)
        if (selection.error) {
          prompt = this.prompt(
            task,
            `Continue the original task: ${task.request.prompt}\n\nBuildFlow could not validate because your pipeline selection was invalid: ${selection.error}`
          )
          continue
        }

        // No code changes → no validation. The agent opted out with [].
        if (!selection.pipelines.length) {
          const next = this.continueIfGuidance(task)
          if (next) {
            prompt = next
            continue
          }
          task.running = false
          this.status(task, 'completed', attempt, 'No validation needed')
          return
        }

        const names = selection.pipelines.map((pipeline) => pipeline.name).join(', ')
        this.status(task, 'validating', attempt, `Running ${names}`)
        const failures: { pipeline: Pipeline; result: PipelineRunResult }[] = []
        for (const pipeline of selection.pipelines) {
          const activity: PipelineActivity = {
            pipelineId: pipeline.id,
            pipelineName: pipeline.name,
            status: 'running',
            startedAt: Date.now()
          }
          task.pipelineRuns.push(activity)
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
            this.pipelineStatus(task, activity)
            throw error
          }
          activity.status = result.cancelled ? 'cancelled' : result.ok ? 'passed' : 'failed'
          activity.finishedAt = Date.now()
          activity.durationMs = activity.finishedAt - activity.startedAt
          activity.runId = result.runId
          this.pipelineStatus(task, activity)
          if (task.cancelled) {
            this.settleCancel(task)
            return
          }
          if (result.cancelled) {
            task.running = false
            this.status(task, 'needs-attention', attempt, 'Validation stopped unexpectedly')
            return
          }
          if (!result.ok) failures.push({ pipeline, result })
        }
        if (!failures.length) {
          const next = this.continueIfGuidance(task)
          if (next) {
            prompt = next
            continue
          }
          task.running = false
          this.status(task, 'completed', attempt, `${names} passed`)
          return
        }

        const guidance = task.guidance.splice(0).join('\n')
        prompt = this.prompt(
          task,
          [
            `Continue the original task: ${task.request.prompt}`,
            '',
            `BuildFlow validation attempt ${attempt} failed. Fix the code, then finish so BuildFlow can validate again.`,
            ...failures.flatMap(({ pipeline, result }) => [
              result.reportPath ? `Read the full failure report at ${result.reportPath}.` : '',
              failureContext(pipeline, result)
            ]),
            guidance ? `Additional user guidance:\n${guidance}` : ''
          ]
            .filter(Boolean)
            .join('\n\n')
        )
      }

      if (task.cancelled) {
        this.settleCancel(task)
        return
      }
      task.running = false
      this.status(task, 'needs-attention', maxAttempts, `Validation still fails after ${maxAttempts} attempts`)
    } catch (error) {
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
    }
  }

  private prompt(task: Task, opening: string): string {
    return [
      opening,
      '',
      `Work only in ${task.request.cwd}.`,
      this.pipelineHistory(task),
      `When the requested code change is complete, select every relevant validation pipeline from the catalog below. If you made no code changes, select none (\`[]\`). BuildFlow will run your selections and return any failures for you to repair.`,
      `Do not call the BuildFlow MCP tools in this managed Chat session. They require approval in some providers; the managed harness executes your selected pipelines directly.`,
      `End every response with exactly one line in this format: ${PIPELINES_MARKER} ["pipeline-id"] — or ${PIPELINES_MARKER} [] when no validation is needed. Use a JSON array and only ids from the catalog.`,
      '',
      `Available BuildFlow pipelines:\n${pipelineCatalog(task.request.pipelines)}`,
      `If a block or error prevents you from completing the task, stop immediately and end your response with “${BLOCK_MARKER} <reason>”. Do not keep trying.`
    ]
      .filter(Boolean)
      .join('\n')
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
    return `BuildFlow pipeline activity for this chat:\n${lines.join('\n')}`
  }

  private runAgent(task: Task, prompt: string, sink: AgentSink): Promise<number> {
    const spec = managedAiCommand(task.request.provider, prompt)
    const env = shellEnv()
    env.PATH = searchPath()
    const bin = resolveBin(spec.bins, env.PATH)
    if (!bin) {
      sink.text(`buildflow: ${spec.hint}\n`)
      return Promise.resolve(127)
    }

    // A streaming provider keeps its diagnostics out of the transcript, so
    // hold on to the tail and show it if the run turns out to have failed.
    const parser = spec.stream === 'ndjson' ? new AgentStreamParser() : null
    let diagnostics = ''
    // Chunks split wherever the pipe fills, including mid-character.
    const stdoutText = new StringDecoder('utf8')
    const stderrText = new StringDecoder('utf8')

    const consume = (events: ReturnType<AgentStreamParser['push']>): void => {
      for (const event of events) {
        if (event.kind === 'text') sink.turn(event.text)
        else if (event.kind === 'raw') sink.text(plainText(event.text))
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
        sink.text(`buildflow: ${error instanceof Error ? error.message : String(error)}\n`)
        done(127)
        return
      }
      task.process = child
      child.stdout?.on('data', (chunk: Buffer) => {
        // JSON carries its own escaping, and plainText's per-line trimming
        // would eat a space that straddles two chunks. Parse the bytes as-is.
        const text = stdoutText.write(chunk)
        if (parser) consume(parser.push(text))
        else sink.text(plainText(text))
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
        sink.text(`buildflow: ${error.message}\n`)
        done(127)
      })
      child.on('close', (code) => done(code ?? 127))
    })
  }
}
