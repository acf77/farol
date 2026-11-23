/**
 * What stands in for the Farol app around the agent: the pipeline runner, the
 * Git actions and the todo store. Pipelines really run (shell steps, in the
 * checkout) and write the same failure report the app writes. Commits and pushes
 * go through the app's own `performGitAction`, against real `.git/hooks` and a
 * local `origin`. Only opening a pull request is faked, since that is GitHub.
 * Each records what happened for grading.
 */

import fs from 'fs'
import path from 'path'
import type { GitActions } from '../electron/agent-controller'
import { captureLimited } from '../electron/delegate-snapshot'
import { performGitAction } from '../electron/git-actions'
import { currentBranch, type GitScope } from '../electron/git'
import { FAILURE_REPORT_REL, failureReport, gitignoreWithEntry } from '../shared/failure'
import type { GitAction, GitActionResult } from '../shared/git-action'
import { topoSort } from '../shared/graph'
import { sanitizeTodos, type Todo, type TodoStore } from '../shared/todos'
import type { Pipeline, PipelineRunResult, PipelineStepResult } from '../shared/types'
import type { GitActionTrace, PipelineRunTrace, Surface } from './types'
import { sh } from './workspace'

/** Counts finished attempts, so a pipeline run or Git action can say which attempt it followed. */
export interface AttemptClock {
  finished: number
}

export class BenchRunner {
  readonly runs: PipelineRunTrace[] = []
  private seq = 0

  constructor(
    private readonly bareIds: Map<string, string>,
    private readonly clock: AttemptClock,
    private readonly via: Surface
  ) {}

  async run(
    pipeline: Pipeline,
    cwd: string,
    branch: string,
    _origin?: string,
    signal?: AbortSignal
  ): Promise<PipelineRunResult> {
    const tree = (await captureLimited(cwd).catch(() => undefined))?.tree
    const nodes = topoSort(pipeline.nodes) ?? pipeline.nodes
    const steps: PipelineStepResult[] = []
    let blocked = false
    let failed: { node: (typeof nodes)[number]; step: PipelineStepResult } | undefined
    for (const node of nodes) {
      if (blocked || signal?.aborted) {
        steps.push({ nodeId: node.id, ok: false, code: 0, skipped: true, output: '' })
        continue
      }
      if (node.type !== 'shell') {
        // The fixture has shell steps only; anything else would need an agent or a diff.
        steps.push({ nodeId: node.id, ok: true, code: 0, output: '' })
        continue
      }
      const res = await sh(node.cmd, cwd, 120_000, signal)
      const step = { nodeId: node.id, ok: res.code === 0, code: res.code, output: res.output }
      steps.push(step)
      if (!step.ok) {
        failed ??= { node, step }
        if (node.gate !== false) blocked = true
      }
    }
    const ok = !failed
    const reportPath = failed
      ? writeReport(cwd, pipeline, branch, failed.node.name || failed.node.id, failed.node.cmd, failed.step)
      : undefined
    this.runs.push({
      id: this.bareIds.get(pipeline.id) ?? pipeline.id,
      ok,
      afterAttempt: this.clock.finished,
      via: this.via,
      ...(tree ? { tree } : {}),
      ...(failed ? { failedOutput: failed.step.output.slice(-4000) } : {})
    })
    return {
      runId: `bench-${++this.seq}`,
      pipelineId: pipeline.id,
      ok,
      ...(signal?.aborted ? { cancelled: true } : {}),
      ...(failed ? { failedNodeId: failed.node.id } : {}),
      ...(reportPath ? { reportPath } : {}),
      steps
    }
  }
}

/** The app's `writeFailureReport`, minus its error handling: `.farol/last-failure.md`, kept out of Git. */
function writeReport(cwd: string, pipeline: Pipeline, branch: string, step: string, cmd: string, result: PipelineStepResult): string {
  const file = path.join(cwd, FAILURE_REPORT_REL)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const ignore = path.join(path.dirname(file), '.gitignore')
  const current = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : ''
  const next = gitignoreWithEntry(current, path.basename(file))
  if (next !== null) fs.writeFileSync(ignore, next)
  fs.writeFileSync(
    file,
    failureReport({ pipeline: pipeline.name, pipelineId: pipeline.id, step, branch, cwd, cmd, code: result.code, output: result.output })
  )
  return file
}

/** The run summary an MCP `run_pipeline` call returns; mirrors `formatAgentRunReport` in `electron/main.ts`. */
export function mcpRunReport(pipeline: Pipeline, branch: string, result: PipelineRunResult): string {
  const nodes = topoSort(pipeline.nodes) ?? pipeline.nodes
  const byId = new Map(result.steps.map((step) => [step.nodeId, step]))
  const lines = [`${result.ok ? 'PASSED' : 'FAILED'}: ${pipeline.name} on ${branch}`, '']
  for (const node of nodes) {
    const step = byId.get(node.id)
    const label = !step || step.skipped ? 'SKIP' : step.ok ? 'PASS' : 'FAIL'
    lines.push(`[${label}] ${node.name || node.id}${label === 'FAIL' ? ` (exit ${step?.code})` : ''}`)
  }
  for (const node of nodes) {
    const step = byId.get(node.id)
    if (!step || step.ok || step.skipped) continue
    const text = step.output.trim().slice(-8000)
    if (text) lines.push('', `--- output: ${node.name || node.id} ---`, text)
  }
  return lines.join('\n')
}

/** Farol's Git actions, with pull requests faked. */
export class BenchGit implements GitActions {
  readonly actions: GitActionTrace[] = []
  private prs = 0

  constructor(
    private readonly repo: string,
    private readonly on: boolean,
    private readonly clock: AttemptClock,
    private readonly via: Surface
  ) {}

  async enabled(): Promise<boolean> {
    return this.on
  }

  branch(cwd: string): Promise<string | undefined> {
    return currentBranch(cwd)
  }

  async run(cwd: string, request: GitAction, scope: GitScope): Promise<GitActionResult> {
    const result =
      request.action === 'create_pr'
        ? await this.pullRequest(cwd, request)
        : await performGitAction(cwd, request, this.repo, scope)
    this.actions.push({
      request,
      ok: result.ok,
      message: result.message,
      hookBlocked: !!result.hookRun,
      afterAttempt: this.clock.finished,
      via: this.via
    })
    return result
  }

  private async pullRequest(cwd: string, request: Extract<GitAction, { action: 'create_pr' }>): Promise<GitActionResult> {
    const head = await currentBranch(cwd)
    const base = request.base ?? 'main'
    if (!head) return { ok: false, message: 'The checkout is on no branch, so there is nothing to open a pull request for.' }
    if (head === base) return { ok: false, message: `The branch ${head} is the base branch, so a pull request has nothing to merge.` }
    this.prs += 1
    const title = request.title ?? '(title from the branch commits)'
    return { ok: true, message: `Opened pull request #${this.prs} (${head} into ${base}): ${title}` }
  }
}

/** The app's per-checkout todo store, in memory. */
export class MemoryTodoStore implements TodoStore {
  readonly saves: Todo[][] = []
  private readonly lists = new Map<string, Todo[]>()

  constructor(checkout: string, initial: Todo[] = []) {
    this.lists.set(checkout, initial.map((todo) => ({ ...todo })))
  }

  async load(checkout: string): Promise<Todo[]> {
    return (this.lists.get(checkout) ?? []).map((todo) => ({ ...todo }))
  }

  async save(checkout: string, todos: unknown): Promise<void> {
    const list = sanitizeTodos(todos)
    this.lists.set(checkout, list)
    this.saves.push(list.map((todo) => ({ ...todo })))
  }

  async forget(checkout: string): Promise<void> {
    this.lists.delete(checkout)
  }

  current(checkout: string): Todo[] {
    return (this.lists.get(checkout) ?? []).map((todo) => ({ ...todo }))
  }
}
