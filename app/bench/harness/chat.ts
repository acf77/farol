/**
 * The `chat` surface: Farol's managed Chat, unmodified. The real
 * `AgentController` builds the prompt, starts the agent's CLI the way the app
 * does (`managedAiCommand`), reads its control lines, runs the pipelines it
 * selects, sends failures back for repair and performs its Git actions. The
 * bench only supplies the app's surroundings (`../farol.ts`) and watches.
 *
 * Each agent run is one attempt. The controller keeps `runAgent` private, so
 * the bench wraps it on the instance to see each prompt and what the run did;
 * a scripted agent (tests) is wrapped as the executor instead.
 */

import { AgentController, type AgentExecutor } from '../../electron/agent-controller'
import { captureLimited, changedPaths } from '../../electron/delegate-snapshot'
import type { AgentTaskEvent, AgentTaskRequest } from '../../shared/types'
import { BenchGit, BenchRunner, MemoryTodoStore, type AttemptClock } from '../farol'
import { attemptSelection, retryReason } from '../grade'
import type { AttemptTrace, BenchCase, FinalStatus, Reference, Subject, ToolCall, Trace } from '../types'
import { claudeUsage, emptyUsage } from '../usage'
import { createWorkspace, disposeWorkspace, runAcceptance, type Workspace } from '../workspace'

export interface RunOptions {
  trial: number
  /** Where workspaces are created. */
  root: string
  timeoutMs: number
  /** A scripted agent; without one the subject's real CLI runs. */
  executor?: AgentExecutor
  /** Leave the workspace on disk for inspection. */
  keep?: boolean
  log?: (line: string) => void
}

/** What the bench says if a question cannot be dismissed the way the UI does it. */
export const AUTO_ANSWER = 'No preference. Use your best judgment and go ahead.'
const MAX_AUTO_ANSWERS = 2
const MAX_PROMPT_CHARS = 40_000
const TERMINAL = new Set(['completed', 'needs-attention', 'failed', 'cancelled'])

/** An executor that plays a case's reference: a correct agent, for self-tests. */
export function scriptedAgent(reference: Reference): AgentExecutor {
  let attempt = 0
  return async (request, prompt, onOutput, onTool) => {
    const turn = reference({ repo: request.cwd, attempt: attempt++, prompt })
    const { text, tools = [] } = typeof turn === 'string' ? { text: turn } : turn
    tools.forEach((tool, i) => onTool?.({ toolId: `scripted-${attempt}-${i}`, name: tool.name, ...(tool.detail ? { detail: tool.detail } : {}), state: 'done' }))
    onOutput(`${text}\n`)
    return 0
  }
}

type RunAgent = (task: unknown, prompt: string, sink: unknown, plain?: boolean, opts?: { child?: unknown }) => Promise<number>

const tree = async (repo: string): Promise<string | undefined> => (await captureLimited(repo).catch(() => undefined))?.tree

/** What the agent said and did in `events`, its own words only (not a subagent's). */
function said(events: AgentTaskEvent[]): { text: string; tools: ToolCall[] } {
  let text = ''
  const tools = new Map<string, ToolCall>()
  for (const event of events) {
    if (event.kind === 'assistant' && !event.delegateId) text += `${text && !text.endsWith('\n') ? '\n' : ''}${event.text}\n`
    else if (event.kind === 'output' && !event.delegateId) text += event.chunk
    else if (event.kind === 'tool' && !event.delegateId) {
      // The finished event may drop the detail the started one carried.
      const detail = event.detail ?? tools.get(event.toolId)?.detail
      tools.set(event.toolId, { name: event.name, ...(detail ? { detail } : {}), state: event.state })
    }
  }
  return { text, tools: [...tools.values()] }
}

class AttemptRecorder {
  readonly attempts: AttemptTrace[] = []
  readonly clock: AttemptClock = { finished: 0 }
  lastTree: string | undefined
  inFlight: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly ws: Workspace,
    private readonly events: AgentTaskEvent[]
  ) {}

  record(prompt: string, run: () => Promise<number>): Promise<number> {
    const work = this.track(prompt, run)
    this.inFlight = work.catch(() => undefined)
    return work
  }

  private async track(prompt: string, run: () => Promise<number>): Promise<number> {
    const index = this.attempts.length
    const from = this.events.length
    const before = await tree(this.ws.repo)
    const started = Date.now()
    let code = 1
    try {
      code = await run()
      return code
    } finally {
      const after = await tree(this.ws.repo)
      const { text, tools } = said(this.events.slice(from))
      const changedFiles = before && after && before !== after ? await changedPaths(this.ws.repo, before, after).catch(() => []) : []
      this.attempts.push({
        index,
        prompt: prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS)}\n[… trimmed]` : prompt,
        ...(index ? { reason: retryReason(prompt) } : {}),
        text,
        tools,
        exitCode: code,
        durationMs: Date.now() - started,
        changedFiles,
        selection: attemptSelection({ text }, this.ws.bareIds)
      })
      this.clock.finished = this.attempts.length
      this.lastTree = after
    }
  }
}

export async function runChat(c: BenchCase, subject: Subject, opts: RunOptions): Promise<Trace> {
  const started = Date.now()
  const ws = createWorkspace(c, opts.root)
  const events: AgentTaskEvent[] = []
  const recorder = new AttemptRecorder(ws, events)
  const runner = new BenchRunner(ws.bareIds, recorder.clock, 'chat')
  const git = new BenchGit(ws.repo, c.git?.enabled ?? false, recorder.clock, 'chat')
  const todos = new MemoryTodoStore(ws.repo, c.todos)
  let wake = (): void => {}
  const emit = (event: AgentTaskEvent): void => {
    events.push(event)
    wake()
  }

  const scripted = opts.executor
  const executor: AgentExecutor | undefined = scripted
    ? (request, prompt, onOutput, onTool, session) =>
        recorder.record(prompt, () => scripted(request, prompt, onOutput, onTool, session))
    : undefined
  const controller = new AgentController(runner, emit, executor, todos, undefined, undefined, undefined, undefined, git)
  if (!scripted) {
    const target = controller as unknown as { runAgent: RunAgent }
    const runAgent = target.runAgent.bind(controller)
    target.runAgent = (task, prompt, sink, plain, more) =>
      // A subagent, or OpenCode's plain-text retry of the same run, is not an attempt of its own.
      more?.child || plain ? runAgent(task, prompt, sink, plain, more) : recorder.record(prompt, () => runAgent(task, prompt, sink, plain, more))
  }

  const taskId = `bench-${c.id.replace(/[^a-z0-9]+/gi, '-')}-${opts.trial}`
  const request: AgentTaskRequest = {
    id: taskId,
    prompt: c.prompt,
    provider: subject.provider,
    ...(subject.model ? { model: subject.model } : {}),
    ...(subject.effort ? { effort: subject.effort } : {}),
    mode: c.mode ?? 'build',
    autoApprove: true,
    pipelines: ws.catalog,
    cwd: ws.repo,
    checkout: ws.repo,
    branch: ws.branch,
    maxAttempts: c.maxAttempts ?? 5
  }

  let status: FinalStatus = 'error'
  let statusMessage: string
  let questionsAsked = 0
  let error: string | undefined
  try {
    const start = controller.start(request)
    if (!start.ok) throw new Error(start.message ?? 'Farol refused to start the chat')
    const end = await new Promise<{ status: FinalStatus; message: string }>((resolve) => {
      let seen = 0
      const asked = new Set<string>()
      const answered = new Set<string>()
      let pending: string | undefined
      const timer = setTimeout(() => {
        controller.cancel(taskId)
        resolve({ status: 'timeout', message: `no answer within ${Math.round(opts.timeoutMs / 1000)}s` })
      }, opts.timeoutMs)
      const finish = (result: { status: FinalStatus; message: string }): void => {
        clearTimeout(timer)
        wake = () => {}
        resolve(result)
      }
      wake = () => {
        for (; seen < events.length; seen++) {
          const event = events[seen]
          if (event.kind === 'question' && !event.answers && !event.dismissed) {
            asked.add(event.requestId)
            pending = event.requestId
            questionsAsked = asked.size
          }
          if (event.kind !== 'status') continue
          opts.log?.(`  [${c.id}] ${event.status}: ${event.message}`)
          if (TERMINAL.has(event.status)) return finish({ status: event.status as FinalStatus, message: event.message })
          // The paused turn reports its attempt; the stream's own notice, while the CLI is still closing, reports 0.
          if (event.status !== 'asking' || event.attempt === 0 || !pending || answered.has(pending)) continue
          if (answered.size >= MAX_AUTO_ANSWERS) {
            controller.cancel(taskId)
            return finish({ status: 'asking', message: `still asking after ${answered.size} answers` })
          }
          const requestId = pending
          answered.add(requestId)
          // Dismiss, as a person would with no preference: Farol tells the agent to use its best judgment.
          setTimeout(() => {
            if (!controller.answer(taskId, requestId, null).ok) controller.message(taskId, AUTO_ANSWER)
          }, 50)
        }
      }
      wake()
    })
    status = end.status
    statusMessage = end.message
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    statusMessage = error
  }

  // A cancelled run is still closing its CLI; let it finish recording.
  await Promise.race([recorder.inFlight, new Promise((resolve) => setTimeout(resolve, 15_000))])
  // The controller writes the turn's checkpoint after it reports; give it a moment before the bench reads the repo.
  await new Promise((resolve) => setTimeout(resolve, 300))

  const sessions = events.flatMap((event) => (event.kind === 'context' && event.context.session ? [event.context.session.id] : []))
  const finalTree = recorder.lastTree ?? (await tree(ws.repo))
  const trace: Trace = {
    caseId: c.id,
    subject: subject.label,
    trial: opts.trial,
    surface: 'chat',
    status,
    statusMessage,
    attempts: recorder.attempts,
    pipelineRuns: runner.runs,
    gitActions: git.actions,
    todoSaves: todos.saves,
    todosBefore: c.todos ?? [],
    todosAfter: todos.current(ws.repo),
    questionsAsked,
    agentChangedFiles: [...new Set(recorder.attempts.flatMap((a) => a.changedFiles))].sort(),
    ...(finalTree ? { finalTree } : {}),
    acceptance: await runAcceptance(c, ws.repo),
    catalog: ws.catalog.map((p) => ({
      id: ws.bareIds.get(p.id) ?? p.id,
      cmds: p.nodes.flatMap((node) => (node.type === 'shell' && node.cmd ? [node.cmd] : []))
    })),
    usage: !scripted && subject.provider === 'claude' ? claudeUsage(sessions) : { ...emptyUsage(), sessions },
    durationMs: Date.now() - started,
    ...(error ? { error } : {})
  }
  if (!opts.keep) disposeWorkspace(ws)
  else opts.log?.(`  [${c.id}] kept ${ws.repo}`)
  return trace
}
