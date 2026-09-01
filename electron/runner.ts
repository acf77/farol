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
import { FAILURE_REPORT_REL, failureReport, gitignoreWithEntry } from '../shared/failure'
import { REPORT_OUTPUT_LIMIT } from '../shared/failure'
import { appendTail, plainText } from '../shared/terminal'
import { exitCodeFromSignal } from '../shared/exit-code'
import { parseVerdict, verdictPromptSuffix } from '../shared/verdict'
import {
  ancestors,
  descendants,
  nodeGate,
  readyIds,
  topoSort,
  validateRunnable
} from '../shared/graph'
import { aiEnv, resolveBinFrom } from './bin'
import { defaultShell, pipelineEnv, PtySession, shellEnv } from './session'
import { killPidTree, killPty } from './kill'
import { shellFamily } from './protocol'

/**
 * Runs a pipeline DAG. Ready nodes start together; a gated shell failure
 * skips its descendants, while AI nodes finish without blocking siblings.
 */

const CONTEXT_LIMIT = 12000
/** Live per-step stdout kept for context, failure reports, and settled results. */
const LIVE_OUTPUT_LIMIT = Math.max(CONTEXT_LIMIT, REPORT_OUTPUT_LIMIT)
/** Trailing window for AI verdict parsing — only the end of the stream matters. */
const VERDICT_SCAN_LIMIT = 16_384
const STEP_RESULT_LIMIT = 4000

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

  constructor(private emit: (e: RunEvent) => void) {}

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
    for (const id of [...this.active.keys()]) this.cancel(id)
  }

  private async execute(pipeline: Pipeline, cwd: string, state: Active): Promise<void> {
    const { runId, branch, origin } = state
    const pipelineId = pipeline.id
    try {
      await this.executeRun(pipeline, cwd, state)
    } catch (error) {
      // Spawn / unexpected throws must still settle waiters (cancelAndWait).
      if (!this.finished.has(runId)) {
        const message = error instanceof Error ? error.message : String(error)
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

    this.emit({ kind: 'start', runId, pipelineId, branch, origin, steps: nodes.length })

    if (invalid) {
      this.settleInvalid(state, graph, invalid)
      return
    }

    if (!(await this.openRunShell(cwd, state, graph))) return

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

  private async openRunShell(cwd: string, state: Active, graph: RunGraph): Promise<boolean> {
    const { runId, branch, origin } = state
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
      const message = error instanceof Error ? error.message : String(error)
      this.emitOut(state, graph, graph.nodes[0]?.id ?? 'n1', `farol: failed to spawn login shell: ${message}\r\n`)
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
        steps: []
      })
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
    const ancestorIds = new Set(ancestors(graph.nodes, node.id))
    const context = graph.nodes
      .filter((n) => ancestorIds.has(n.id))
      .map((n) => graph.outputs[n.id] || '')
      .join('')
      .trim()
      .slice(-CONTEXT_LIMIT)
    const onChunk = (chunk: string): void => this.emitOut(state, graph, node.id, chunk)
    const startedAt = Date.now()
    const code = await this.runStep(node, cwd, context, state, onChunk)
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

  private async runStep(
    node: PipelineNode,
    cwd: string,
    context: string,
    state: Active,
    onChunk: (chunk: string) => void
  ): Promise<number> {
    if (node.type === 'shell') {
      if (state.cancelled) return 130
      const takeSession = !!state.session && !state.sessionBusy
      if (takeSession && state.session) {
        state.sessionBusy = true
        state.currentShellId = node.id
        try {
          const { code } = await state.session.exec(node.cmd)
          return code
        } finally {
          if (state.currentShellId === node.id) state.currentShellId = null
          state.sessionBusy = false
        }
      }
      return this.runOneshot(node.id, node.cmd, cwd, state, onChunk)
    }

    const prompt = [
      context ? `${node.cmd}\n\n--- Pipeline output so far ---\n${context}` : node.cmd,
      verdictPromptSuffix()
    ].join('\n')
    const spec = aiCommand(normalizeAi(node.ai), prompt)
    const bin = resolveBinFrom(spec.bins)
    if (!bin) {
      const listed = spec.bins.map((b) => `'${b}'`).join(' or ')
      onChunk(`farol: ${listed} is not on PATH. ${spec.hint}\r\n`)
      return 127
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
          env: aiEnv()
        })
      } catch (err) {
        onChunk(`farol: ${err instanceof Error ? err.message : String(err)}\r\n`)
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
        const verdict = parseVerdict(collected)
        if (verdict === 'pass') done(0)
        else if (verdict === 'fail') done(1)
        else done(exit)
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
        onChunk(`farol: ${err instanceof Error ? err.message : String(err)}\r\n`)
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
