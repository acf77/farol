import * as pty from 'node-pty'
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import type {
  Pipeline,
  PipelineNode,
  PipelineRunResult,
  PipelineStepResult,
  RunEvent,
  RunOrigin
} from '../shared/types'
import { aiCommand, normalizeAi } from '../shared/ai'
import { FAILURE_REPORT_REL, failureReport, gitignoreWithEntry, REPORT_OUTPUT_LIMIT } from '../shared/failure'
import { appendTail, plainText } from '../shared/terminal'
import { exitCodeFromSignal } from '../shared/exit-code'
import { parseVerdict, verdictPromptSuffix, type StepVerdict } from '../shared/verdict'
import {
  ancestorVars,
  descendants,
  expandVars,
  nodeGate,
  quoteShellArg,
  readyIds,
  topoSort,
  validateRunnable
} from '../shared/graph'
import { aiEnv, resolveBinFrom } from './bin'
import { openRouterAgent } from './openrouter-agent'
import { defaultShell, pipelineEnv, PtySession } from './session'
import { killPidTree, killPty } from './kill'
import { errorMessage } from '../shared/jev'
import { verdictFromOutput } from './jev'
import { shellFamily } from './protocol'
import { openRemote as openRemoteWorkspace, type OpenRemote, type RemoteWorkspace } from './remote'

/**
 * Runs a pipeline DAG. Ready nodes start together; a gated shell failure
 * skips its descendants, while AI nodes finish without blocking siblings.
 * Shell cmds and AI prompts expand `${name}` from ancestor named outputs.
 * A `remote` pipeline runs its shell steps in a sandbox on the Farol service holding a snapshot of
 * the checkout; AI steps always run here, where the agent CLIs are signed in.
 */

/** Live per-step stdout kept for named vars, failure reports, and settled results. */
const LIVE_OUTPUT_LIMIT = Math.max(12_000, REPORT_OUTPUT_LIMIT)
/** Trailing window for AI verdict parsing — only the end of the stream matters. */
const VERDICT_SCAN_LIMIT = 16_384
const STEP_RESULT_LIMIT = 4000
/** Tries to start a remote sandbox before the run fails (or falls back to this machine). */
const REMOTE_START_ATTEMPTS = 3
const REMOTE_START_BACKOFF_MS = 500

/**
 * Leave a failed step somewhere an agent can read it. The file lives in the
 * working copy that failed (which may be a worktree), so a terminal sitting in
 * that folder can refer to it by the relative path every agent is handed.
 */
function writeFailureReport(
  cwd: string,
  pipelineName: string,
  pipelineId: string,
  branch: string,
  node: PipelineNode | undefined,
  output: string,
  code: number
): string | undefined {
  if (!node) return undefined
  try {
    const file = path.join(cwd, FAILURE_REPORT_REL)
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })

    const ignore = path.join(dir, '.gitignore')
    const current = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : ''
    const next = gitignoreWithEntry(current, path.basename(file))
    if (next !== null) fs.writeFileSync(ignore, next, 'utf8')

    fs.writeFileSync(
      file,
      failureReport({
        pipeline: pipelineName,
        pipelineId,
        step: node.name || node.id,
        branch,
        cwd,
        cmd: node.cmd,
        code,
        output
      }),
      'utf8'
    )
    return file
  } catch {
    // A read-only checkout is not a reason to fail the run.
    return undefined
  }
}

interface Active {
  runId: string
  branch: string
  origin: RunOrigin
  session: PtySession | null
  remote: RemoteWorkspace | null
  /** Aborts sandbox creation and in-flight remote commands on cancel. */
  abort: AbortController
  sessionBusy: boolean
  currentShellId: string | null
  aiProcs: Map<string, pty.IPty>
  oneshots: Map<string, ChildProcess>
  finishers: Map<string, (code: number) => void>
  cancelled: boolean
}

interface RunGraph {
  pipelineId: string
  nodes: PipelineNode[]
  indexOf: Map<string, number>
  byId: Map<string, PipelineNode>
  outputs: Record<string, string>
  done: Set<string>
  skipped: Set<string>
  started: Set<string>
  stepResults: Map<string, PipelineStepResult>
  failedAt?: number
  failedNodeId?: string
  failedCode: number
}

function defaultStepResult(nodeId: string): PipelineStepResult {
  return { nodeId, ok: false, code: 0, skipped: true, output: '' }
}

function settleSteps(nodes: PipelineNode[], stepResults: Map<string, PipelineStepResult>): PipelineStepResult[] {
  return nodes.map((node) => stepResults.get(node.id) ?? defaultStepResult(node.id))
}

export class PipelineRunner {
  private active = new Map<string, Active>()
  private waiters = new Map<string, ((result: PipelineRunResult) => void)[]>()
  private finished = new Map<string, PipelineRunResult>()

  constructor(
    private emit: (e: RunEvent) => void,
    private openRemote: OpenRemote = openRemoteWorkspace
  ) {}

  async run(
    pipeline: Pipeline,
    cwd: string,
    branch: string,
    origin: RunOrigin = 'app',
    signal?: AbortSignal
  ): Promise<PipelineRunResult> {
    if (signal?.aborted) {
      return {
        runId: `${pipeline.id}:cancelled`,
        pipelineId: pipeline.id,
        ok: false,
        cancelled: true,
        steps: []
      }
    }
    const existing = this.active.get(pipeline.id)
    if (existing) {
      await this.wait(existing.runId)
      return this.run(pipeline, cwd, branch, origin, signal)
    }
    const runId = this.start(pipeline, cwd, branch, origin)
    const cancel = (): void => this.cancel(pipeline.id)
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      return await this.wait(runId)
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  private wait(runId: string): Promise<PipelineRunResult> {
    const result = this.finished.get(runId)
    if (result) return Promise.resolve(result)
    return new Promise((resolve) => {
      const list = this.waiters.get(runId) ?? []
      list.push(resolve)
      this.waiters.set(runId, list)
    })
  }

  private settle(result: PipelineRunResult): void {
    this.finished.set(result.runId, result)
    const waiters = this.waiters.get(result.runId) ?? []
    this.waiters.delete(result.runId)
    for (const resolve of waiters) resolve(result)
    setTimeout(() => this.finished.delete(result.runId), 60_000)
  }

  start(pipeline: Pipeline, cwd: string, branch: string, origin: RunOrigin = 'app'): string {
    const existing = this.active.get(pipeline.id)
    if (existing && !existing.cancelled) return existing.runId
    // Cancelled runs may still be winding down. Re-assert cancel so any leftover
    // PTYs/oneshots die before this slot is reused (sync MCP callers cannot await).
    if (existing) this.cancel(pipeline.id)

    const runId = `${pipeline.id}:${Date.now()}`
    const state: Active = {
      runId,
      branch,
      origin,
      session: null,
      remote: null,
      abort: new AbortController(),
      sessionBusy: false,
      currentShellId: null,
      aiProcs: new Map(),
      oneshots: new Map(),
      finishers: new Map(),
      cancelled: false
    }
    this.active.set(pipeline.id, state)
    void this.execute(pipeline, cwd, state)
    return runId
  }

  cancel(pipelineId: string): void {
    const state = this.active.get(pipelineId)
    if (!state) return
    state.cancelled = true
    state.abort.abort()
    void state.remote?.close()
    state.session?.interrupt()
    for (const proc of state.aiProcs.values()) killPty(proc)
    state.aiProcs.clear()
    for (const child of state.oneshots.values()) {
      if (child.pid) killPidTree(child.pid)
    }
    state.oneshots.clear()
    for (const done of state.finishers.values()) done(130)
    state.finishers.clear()
    state.session?.kill()
  }

  /** Stop a run and wait until it has fully left `active`, so a re-run can start cleanly. */
  async cancelAndWait(pipelineId: string): Promise<void> {
    const state = this.active.get(pipelineId)
    if (!state) return
    const { runId } = state
    this.cancel(pipelineId)
    await this.wait(runId)
  }

  cancelAll(): void {
    for (const id of this.active.keys()) this.cancel(id)
  }

  private async execute(pipeline: Pipeline, cwd: string, state: Active): Promise<void> {
    const { runId, branch, origin } = state
    const pipelineId = pipeline.id
    try {
      await this.executeRun(pipeline, cwd, state)
    } catch (error) {
      // Spawn / unexpected throws must still settle waiters (cancelAndWait).
      if (!this.finished.has(runId)) {
        const message = errorMessage(error)
        this.emit({
          kind: 'output',
          runId,
          pipelineId,
          branch,
          origin,
          index: 0,
          nodeId: pipeline.nodes[0]?.id ?? 'n1',
          chunk: `farol: ${message}\r\n`
        })
        this.emit({
          kind: 'end',
          runId,
          pipelineId,
          branch,
          origin,
          ok: false,
          failedAt: 0,
          failedNodeId: pipeline.nodes[0]?.id,
          cancelled: state.cancelled || undefined
        })
        this.settle({
          runId,
          pipelineId,
          ok: false,
          cancelled: state.cancelled || undefined,
          failedNodeId: pipeline.nodes[0]?.id,
          steps: []
        })
      }
    } finally {
      // Only drop active when this run still owns the slot — a newer re-run may
      // have replaced us while we were winding down.
      void state.remote?.close()
      if (this.active.get(pipelineId)?.runId === runId) {
        this.active.delete(pipelineId)
      }
    }
  }

  private async executeRun(pipeline: Pipeline, cwd: string, state: Active): Promise<void> {
    const { runId, branch, origin } = state
    const pipelineId = pipeline.id
    const invalid = validateRunnable(pipeline.nodes)
    const nodes = invalid ? pipeline.nodes : (topoSort(pipeline.nodes) as PipelineNode[])
    const graph: RunGraph = {
      pipelineId,
      nodes,
      indexOf: new Map(nodes.map((n, i) => [n.id, i])),
      byId: new Map(nodes.map((n) => [n.id, n])),
      outputs: {},
      done: new Set(),
      skipped: new Set(),
      started: new Set(),
      stepResults: new Map(),
      failedCode: 1
    }

    this.emit({ kind: 'start', runId, pipelineId, branch, origin, steps: nodes.length, cwd, startedAt: Date.now() })

    if (invalid) {
      this.settleInvalid(state, graph, invalid)
      return
    }

    const opened =
      pipeline.target === 'remote'
        ? await this.openRemoteWorkspace(cwd, state, graph, pipeline.fallbackLocal === true)
        : await this.openRunShell(cwd, state, graph)
    if (!opened) return

    const inflight = new Map<string, Promise<void>>()
    const pump = (): void => this.pumpReady(cwd, state, graph, inflight)

    pump()
    while (inflight.size) {
      await Promise.race(inflight.values())
      if (state.cancelled) {
        this.markUnstartedCancelled(state, graph)
        break
      }
      pump()
    }

    await state.remote?.close()
    this.finalizeGraph(pipeline, cwd, state, graph)
  }

  private emitOut(state: Active, graph: RunGraph, nodeId: string, chunk: string): void {
    const { runId, branch, origin } = state
    graph.outputs[nodeId] = appendTail(graph.outputs[nodeId] || '', plainText(chunk), LIVE_OUTPUT_LIMIT)
    this.emit({
      kind: 'output',
      runId,
      pipelineId: graph.pipelineId,
      branch,
      origin,
      index: graph.indexOf.get(nodeId) ?? 0,
      nodeId,
      chunk
    })
  }

  private settleInvalid(state: Active, graph: RunGraph, invalid: string): void {
    const { runId, branch, origin } = state
    const nodeId = graph.nodes[0]?.id ?? 'n1'
    this.emitOut(state, graph, nodeId, `farol: ${invalid}\r\n`)
    this.emit({
      kind: 'end',
      runId,
      pipelineId: graph.pipelineId,
      branch,
      origin,
      ok: false,
      failedAt: 0,
      failedNodeId: graph.nodes[0]?.id,
      cancelled: state.cancelled || undefined
    })
    this.settle({
      runId,
      pipelineId: graph.pipelineId,
      ok: false,
      cancelled: state.cancelled || undefined,
      failedNodeId: graph.nodes[0]?.id,
      steps: graph.nodes.map((node) => ({
        nodeId: node.id,
        ok: false,
        code: 1,
        skipped: true,
        output: node.id === nodeId ? `farol: ${invalid}` : ''
      }))
    })
  }

  /** End a run that could not start any step, saying why when there is a reason. */
  private failRun(state: Active, graph: RunGraph, reason?: string): void {
    const { runId, branch, origin } = state
    const nodeId = graph.nodes[0]?.id
    if (reason) this.emitOut(state, graph, nodeId ?? 'n1', `farol: ${reason}\r\n`)
    this.emit({
      kind: 'end',
      runId,
      pipelineId: graph.pipelineId,
      branch,
      origin,
      ok: false,
      failedAt: 0,
      failedNodeId: nodeId,
      cancelled: state.cancelled || undefined
    })
    this.settle({
      runId,
      pipelineId: graph.pipelineId,
      ok: false,
      cancelled: state.cancelled || undefined,
      failedNodeId: nodeId,
      steps: []
    })
  }

  /** Tries to open the remote sandbox up to REMOTE_START_ATTEMPTS times; returns the last failure message. */
  private async retryOpenRemote(cwd: string, state: Active, graph: RunGraph, first: string): Promise<string> {
    let failure = ''
    for (let attempt = 1; attempt <= REMOTE_START_ATTEMPTS && !state.remote; attempt++) {
      const retry = attempt > 1 ? ` (attempt ${attempt}/${REMOTE_START_ATTEMPTS})` : ''
      this.emitOut(state, graph, first, `farol: starting remote sandbox${retry}…\r\n`)
      try {
        state.remote = await this.openRemote(cwd, state.abort.signal)
      } catch (error) {
        if (state.cancelled) break
        failure = String((error as Error)?.message ?? error)
        this.emitOut(state, graph, first, `farol: remote sandbox failed to start: ${failure}\r\n`)
        if (attempt < REMOTE_START_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, REMOTE_START_BACKOFF_MS * attempt))
      }
    }
    return failure
  }

  private async openRemoteWorkspace(
    cwd: string,
    state: Active,
    graph: RunGraph,
    fallbackLocal: boolean
  ): Promise<boolean> {
    const first = graph.nodes[0]?.id ?? 'n1'
    const failure = await this.retryOpenRemote(cwd, state, graph, first)
    if (!state.remote) {
      if (state.cancelled) {
        this.failRun(state, graph, undefined)
        return false
      }
      if (fallbackLocal) {
        this.emitOut(state, graph, first, 'farol: falling back to this machine\r\n')
        return this.openRunShell(cwd, state, graph)
      }
      this.failRun(state, graph, `remote run could not start after ${REMOTE_START_ATTEMPTS} attempts: ${failure}`)
      return false
    }
    if (state.cancelled) {
      await state.remote.close()
      state.remote = null
      this.markUnstartedCancelled(state, graph)
    } else {
      this.emitOut(state, graph, first, `farol: running on remote sandbox (${state.remote.summary})\r\n`)
    }
    return true
  }

  private async openRunShell(cwd: string, state: Active, graph: RunGraph): Promise<boolean> {
    try {
      state.session = new PtySession({
        cwd,
        cols: 110,
        onData: (chunk) => {
          if (state.currentShellId) this.emitOut(state, graph, state.currentShellId, chunk)
        },
        onEnd: () => {
          state.session = null
        }
      })
    } catch (error) {
      const message = errorMessage(error)
      this.failRun(state, graph, `failed to spawn login shell: ${message}`)
      return false
    }

    const shellReady = await state.session.whenReady()
    if (state.cancelled) {
      state.session?.kill()
      state.session = null
    } else if (!shellReady) {
      this.emitOut(
        state,
        graph,
        graph.nodes[0]?.id ?? 'n1',
        'farol: login shell did not become ready; shell steps run as one-shot commands.\r\n'
      )
      state.session?.kill()
      state.session = null
    }
    return true
  }

  private skipCone(state: Active, graph: RunGraph, fromId: string): void {
    const { runId, branch, origin } = state
    for (const id of descendants(graph.nodes, fromId)) {
      if (graph.done.has(id) || graph.skipped.has(id) || graph.started.has(id)) continue
      graph.skipped.add(id)
      graph.stepResults.set(id, { nodeId: id, ok: false, code: 0, skipped: true, output: '' })
      this.emit({
        kind: 'step-end',
        runId,
        pipelineId: graph.pipelineId,
        branch,
        origin,
        index: graph.indexOf.get(id) ?? 0,
        nodeId: id,
        ok: false,
        code: 0,
        durationMs: 0,
        skipped: true
      })
    }
  }

  private async runGraphNode(
    cwd: string,
    state: Active,
    graph: RunGraph,
    node: PipelineNode
  ): Promise<void> {
    const { runId, branch, origin } = state
    const index = graph.indexOf.get(node.id) ?? 0
    this.emit({
      kind: 'step-start',
      runId,
      pipelineId: graph.pipelineId,
      branch,
      origin,
      index,
      nodeId: node.id
    })
    const vars = ancestorVars(graph.nodes, node.id, graph.outputs, graph.stepResults)
    const onChunk = (chunk: string): void => this.emitOut(state, graph, node.id, chunk)
    const startedAt = Date.now()
    const code = await this.runStep(node, cwd, state, onChunk, vars)
    const durationMs = Date.now() - startedAt
    const ok = code === 0 && !state.cancelled
    graph.stepResults.set(node.id, {
      nodeId: node.id,
      ok,
      code,
      output: (graph.outputs[node.id] || '').slice(-STEP_RESULT_LIMIT)
    })
    this.emit({
      kind: 'step-end',
      runId,
      pipelineId: graph.pipelineId,
      branch,
      origin,
      index,
      nodeId: node.id,
      ok,
      code,
      durationMs,
      cancelled: state.cancelled || undefined
    })
    if (state.cancelled) {
      graph.skipped.add(node.id)
      return
    }
    graph.done.add(node.id)
    if (!ok) {
      if (graph.failedNodeId === undefined) {
        graph.failedAt = index
        graph.failedNodeId = node.id
        graph.failedCode = code
      }
      if (nodeGate(node)) this.skipCone(state, graph, node.id)
    }
  }

  private pumpReady(
    cwd: string,
    state: Active,
    graph: RunGraph,
    inflight: Map<string, Promise<void>>
  ): void {
    if (state.cancelled) return
    for (const id of readyIds(graph.nodes, graph.done, graph.skipped, graph.started)) {
      const node = graph.byId.get(id)
      if (!node) continue
      graph.started.add(id)
      const p = this.runGraphNode(cwd, state, graph, node).finally(() => inflight.delete(id))
      inflight.set(id, p)
    }
  }

  private markUnstartedCancelled(state: Active, graph: RunGraph): void {
    const { runId, branch, origin } = state
    for (const n of graph.nodes) {
      if (graph.done.has(n.id) || graph.skipped.has(n.id) || graph.started.has(n.id)) continue
      graph.skipped.add(n.id)
      graph.stepResults.set(n.id, {
        nodeId: n.id,
        ok: false,
        code: 130,
        skipped: true,
        output: ''
      })
      this.emit({
        kind: 'step-end',
        runId,
        pipelineId: graph.pipelineId,
        branch,
        origin,
        index: graph.indexOf.get(n.id) ?? 0,
        nodeId: n.id,
        ok: false,
        code: 130,
        durationMs: 0,
        cancelled: true
      })
    }
  }

  private finalizeGraph(pipeline: Pipeline, cwd: string, state: Active, graph: RunGraph): void {
    const { runId, branch, origin } = state
    state.session?.kill()
    state.session = null
    const reportPath =
      graph.failedNodeId !== undefined && !state.cancelled
        ? writeFailureReport(
            cwd,
            pipeline.name,
            pipeline.id,
            branch,
            graph.byId.get(graph.failedNodeId),
            graph.outputs[graph.failedNodeId] || '',
            graph.failedCode
          )
        : undefined
    const endEvent: RunEvent = {
      kind: 'end',
      runId,
      pipelineId: graph.pipelineId,
      branch,
      origin,
      ok: graph.failedAt === undefined && !state.cancelled,
      failedAt: graph.failedAt,
      failedNodeId: graph.failedNodeId,
      cancelled: state.cancelled || undefined,
      reportPath
    }
    this.emit(endEvent)
    this.settle({
      runId,
      pipelineId: graph.pipelineId,
      ok: endEvent.ok,
      cancelled: endEvent.cancelled,
      failedNodeId: graph.failedNodeId,
      reportPath,
      steps: settleSteps(graph.nodes, graph.stepResults)
    })
  }

  private runStep(
    node: PipelineNode,
    cwd: string,
    state: Active,
    onChunk: (chunk: string) => void,
    vars: Readonly<Record<string, string>>
  ): Promise<number> {
    return node.type === 'shell'
      ? this.runShellStep(node, expandVars(node.cmd, vars, { quote: quoteShellArg }), cwd, state, onChunk)
      : this.runAiStep(node, expandVars(node.cmd, vars), cwd, state, onChunk)
  }

  private async runShellStep(
    node: PipelineNode,
    cmd: string,
    cwd: string,
    state: Active,
    onChunk: (chunk: string) => void
  ): Promise<number> {
    if (state.cancelled) return 130
    if (state.remote) return this.runRemoteStep(state.remote, cmd, state, onChunk)
    if (state.session && !state.sessionBusy) {
      state.sessionBusy = true
      state.currentShellId = node.id
      try {
        const { code } = await state.session.exec(cmd)
        return code
      } finally {
        if (state.currentShellId === node.id) state.currentShellId = null
        state.sessionBusy = false
      }
    }
    return this.runOneshot(node.id, cmd, cwd, state, onChunk)
  }

  private async runRemoteStep(
    remote: RemoteWorkspace,
    cmd: string,
    state: Active,
    onChunk: (chunk: string) => void
  ): Promise<number> {
    try {
      return await remote.exec(cmd, onChunk)
    } catch (error) {
      if (state.cancelled) return 130
      onChunk(`farol: ${errorMessage(error)}\r\n`)
      return 127
    }
  }

  private runAiStep(
    node: PipelineNode,
    cmd: string,
    cwd: string,
    state: Active,
    onChunk: (chunk: string) => void
  ): Promise<number> {
    const prompt = [cmd, verdictPromptSuffix()].join('\n')
    const via = openRouterAgent()
    const spec = aiCommand(normalizeAi(node.ai), prompt, node.model, via)
    const bin = resolveBinFrom(spec.bins)
    if (!bin) {
      const listed = spec.bins.map((b) => `'${b}'`).join(' or ')
      onChunk(`farol: ${listed} is not on PATH. ${spec.hint}\r\n`)
      return Promise.resolve(127)
    }

    return new Promise<number>((resolve) => {
      let collected = ''
      const done = (code: number): void => {
        if (state.finishers.get(node.id) !== done) return
        state.finishers.delete(node.id)
        const proc = state.aiProcs.get(node.id)
        if (proc) {
          state.aiProcs.delete(node.id)
        }
        resolve(code)
      }
      state.finishers.set(node.id, done)
      if (state.cancelled) {
        done(130)
        return
      }

      let proc: pty.IPty
      try {
        proc = pty.spawn(bin, spec.args, {
          name: 'xterm-256color',
          cols: 110,
          rows: 40,
          cwd,
          env: aiEnv(normalizeAi(node.ai), via)
        })
      } catch (err) {
        onChunk(`farol: ${errorMessage(err)}\r\n`)
        done(127)
        return
      }
      state.aiProcs.set(node.id, proc)
      proc.onData((chunk) => {
        collected = appendTail(collected, plainText(chunk), VERDICT_SCAN_LIMIT)
        onChunk(chunk)
      })
      proc.onExit(({ exitCode, signal }) => {
        const exit = exitCode === 0 ? (exitCodeFromSignal(signal) ?? 0) : exitCode
        const exitFromVerdict = (verdict: StepVerdict | null): number =>
          verdict === 'pass' ? 0 : verdict === 'fail' ? 1 : exit
        const verdict = parseVerdict(collected)
        if (verdict) done(exitFromVerdict(verdict))
        else {
          // No FAROL_VERDICT line — ask Jev to read the transcript before
          // falling back to the CLI's own exit code, which is often 0 even
          // when the review it printed found a failure.
          void verdictFromOutput(collected).then((jevVerdict) => done(exitFromVerdict(jevVerdict)))
        }
      })
      if (state.cancelled) {
        killPty(proc)
        done(130)
      }
    })
  }

  private runOneshot(
    nodeId: string,
    cmd: string,
    cwd: string,
    state: Active,
    onChunk: (chunk: string) => void
  ): Promise<number> {
    return new Promise((resolve) => {
      const shell = defaultShell()
      const family = shellFamily(shell)
      const args = family === 'powershell' ? ['-NoLogo', '-Command', cmd] : ['-lc', cmd]
      let child: ChildProcess
      try {
        child = spawn(shell, args, { cwd, env: pipelineEnv(), windowsHide: true })
      } catch (err) {
        onChunk(`farol: ${errorMessage(err)}\r\n`)
        resolve(127)
        return
      }
      state.oneshots.set(nodeId, child)
      const push = (buf: Buffer): void => {
        onChunk(buf.toString().replace(/\r?\n/g, '\r\n'))
      }
      child.stdout?.on('data', push)
      child.stderr?.on('data', push)
      child.on('error', (err) => {
        if (state.oneshots.get(nodeId) === child) state.oneshots.delete(nodeId)
        onChunk(`farol: ${err.message}\r\n`)
        resolve(127)
      })
      child.on('close', (code, signal) => {
        if (state.oneshots.get(nodeId) === child) state.oneshots.delete(nodeId)
        // A signalled step reports 128+signum, so an out-of-memory crash
        // (SIGABRT, 134) is not mistaken for a cancellation (SIGINT, 130).
        resolve(state.cancelled ? 130 : (exitCodeFromSignal(signal) ?? code ?? 127))
      })
    })
  }
}
