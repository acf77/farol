import * as pty from 'node-pty'
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
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
import { plainText } from '../shared/terminal'
import { exitCodeFromSignal } from '../shared/exit-code'
import {
  ancestors,
  descendants,
  nodeGate,
  readyIds,
  topoSort
} from '../shared/graph'
import { defaultShell, pipelineEnv, PtySession, shellEnv } from './session'
import { killPidTree, killPty } from './kill'
import { shellFamily } from './protocol'

/**
 * Runs a pipeline DAG. Ready nodes start together; a gated shell failure
 * skips its descendants, while AI nodes finish without blocking siblings.
 */

const CONTEXT_LIMIT = 12000

function extraBinDirs(): string[] {
  const home = os.homedir()
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.cursor', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin')
  ]
}

function searchDirs(): string[] {
  const fromPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const extra = extraBinDirs().filter((dir) => !fromPath.includes(dir))
  return [...extra, ...fromPath]
}

function resolveBin(name: string): string | null {
  if (name.includes(path.sep)) return fs.existsSync(name) ? name : null
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of searchDirs()) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        /* keep looking */
      }
    }
  }
  return null
}

function aiEnv(): Record<string, string> {
  const env = shellEnv()
  const fromPath = (env.PATH || '').split(path.delimiter).filter(Boolean)
  const extra = extraBinDirs().filter((dir) => !fromPath.includes(dir))
  env.PATH = [...extra, ...fromPath].join(path.delimiter)
  return env
}


/**
 * Leave a failed step somewhere an agent can read it. The file lives in the
 * working copy that failed (which may be a worktree), so a terminal sitting in
 * that folder can refer to it by the relative path every agent is handed.
 */
function writeFailureReport(
  cwd: string,
  pipelineName: string,
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
    // Cancelled runs may still be winding down. Prefer cancelAndWait() first;
    // replacing here keeps sync callers (MCP bridge) from deadlocking.

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
    const { runId } = state
    const pipelineId = pipeline.id
    try {
      await this.executeRun(pipeline, cwd, state)
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
    const nodes = topoSort(pipeline.nodes) ?? pipeline.nodes
    const indexOf = new Map(nodes.map((n, i) => [n.id, i]))
    const byId = new Map(nodes.map((n) => [n.id, n]))

    this.emit({ kind: 'start', runId, pipelineId, branch, origin, steps: nodes.length })

    const outputs: Record<string, string> = {}
    const done = new Set<string>()
    const skipped = new Set<string>()
    const started = new Set<string>()
    const inflight = new Map<string, Promise<void>>()
    const stepResults = new Map<string, PipelineStepResult>()
    let failedAt: number | undefined
    let failedNodeId: string | undefined
    let failedCode = 1

    const emitOut = (nodeId: string, chunk: string): void => {
      outputs[nodeId] = (outputs[nodeId] || '') + plainText(chunk)
      this.emit({
        kind: 'output',
        runId,
        pipelineId,
        branch,
        origin,
        index: indexOf.get(nodeId) ?? 0,
        nodeId,
        chunk
      })
    }

    state.session = new PtySession({
      cwd,
      cols: 110,
      onData: (chunk) => {
        if (state.currentShellId) emitOut(state.currentShellId, chunk)
      },
      onEnd: () => {
        state.session = null
      }
    })
    const shellReady = await state.session.whenReady()
    if (state.cancelled) {
      state.session?.kill()
      state.session = null
    } else if (!shellReady) {
      emitOut(nodes[0]?.id ?? 'n1', 'buildflow: login shell did not become ready; shell steps run as one-shot commands.\r\n')
      state.session?.kill()
      state.session = null
    }

    const skipCone = (fromId: string): void => {
      for (const id of descendants(nodes, fromId)) {
        if (done.has(id) || skipped.has(id) || started.has(id)) continue
        skipped.add(id)
        stepResults.set(id, { nodeId: id, ok: false, code: 0, skipped: true, output: '' })
        this.emit({
          kind: 'step-end',
          runId,
          pipelineId,
          branch,
          origin,
          index: indexOf.get(id) ?? 0,
          nodeId: id,
          ok: false,
          code: 0,
          durationMs: 0,
          skipped: true
        })
      }
    }

    const runNode = async (node: PipelineNode): Promise<void> => {
      const index = indexOf.get(node.id) ?? 0
      this.emit({ kind: 'step-start', runId, pipelineId, branch, origin, index, nodeId: node.id })
      const ancestorIds = new Set(ancestors(nodes, node.id))
      const context = nodes
        .filter((n) => ancestorIds.has(n.id))
        .map((n) => outputs[n.id] || '')
        .join('')
        .trim()
        .slice(-CONTEXT_LIMIT)
      const onChunk = (chunk: string): void => emitOut(node.id, chunk)
      const startedAt = Date.now()
      const code = await this.runStep(node, cwd, context, state, onChunk)
      const durationMs = Date.now() - startedAt
      const ok = code === 0 && !state.cancelled
      stepResults.set(node.id, {
        nodeId: node.id,
        ok,
        code,
        output: (outputs[node.id] || '').slice(-4000)
      })
      this.emit({
        kind: 'step-end',
        runId,
        pipelineId,
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
        skipped.add(node.id)
        return
      }
      done.add(node.id)
      if (!ok) {
        if (failedNodeId === undefined) {
          failedAt = index
          failedNodeId = node.id
          failedCode = code
        }
        if (nodeGate(node)) skipCone(node.id)
      }
    }

    const pump = (): void => {
      if (state.cancelled) return
      for (const id of readyIds(nodes, done, skipped, started)) {
        const node = byId.get(id)
        if (!node) continue
        started.add(id)
        const p = runNode(node).finally(() => inflight.delete(id))
        inflight.set(id, p)
      }
    }

    pump()
    while (inflight.size) {
      await Promise.race([...inflight.values()])
      if (state.cancelled) {
        for (const n of nodes) {
          if (!done.has(n.id) && !skipped.has(n.id) && !started.has(n.id)) {
            skipped.add(n.id)
            stepResults.set(n.id, {
              nodeId: n.id,
              ok: false,
              code: 130,
              skipped: true,
              output: ''
            })
            this.emit({
              kind: 'step-end',
              runId,
              pipelineId,
              branch,
              origin,
              index: indexOf.get(n.id) ?? 0,
              nodeId: n.id,
              ok: false,
              code: 130,
              durationMs: 0,
              cancelled: true
            })
          }
        }
        break
      }
      pump()
    }

    state.session?.kill()
    state.session = null
    const reportPath =
      failedNodeId !== undefined && !state.cancelled
        ? writeFailureReport(
            cwd,
            pipeline.name,
            branch,
            byId.get(failedNodeId),
            outputs[failedNodeId] || '',
            failedCode
          )
        : undefined
    const endEvent: RunEvent = {
      kind: 'end',
      runId,
      pipelineId,
      branch,
      origin,
      ok: failedAt === undefined && !state.cancelled,
      failedAt,
      failedNodeId,
      cancelled: state.cancelled || undefined,
      reportPath
    }
    this.emit(endEvent)
    this.settle({
      runId,
      pipelineId,
      ok: endEvent.ok,
      cancelled: endEvent.cancelled,
      failedNodeId,
      reportPath,
      steps: nodes.map(
        (node) =>
          stepResults.get(node.id) ?? {
            nodeId: node.id,
            ok: false,
            code: 0,
            skipped: true,
            output: ''
          }
      )
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

    const prompt = context ? `${node.cmd}\n\n--- Pipeline output so far ---\n${context}` : node.cmd
    const spec = aiCommand(normalizeAi(node.ai), prompt)
    let bin: string | null = null
    for (const name of spec.bins) {
      bin = resolveBin(name)
      if (bin) break
    }
    if (!bin) {
      const listed = spec.bins.map((b) => `'${b}'`).join(' or ')
      onChunk(`buildflow: ${listed} is not on PATH. ${spec.hint}\r\n`)
      return 127
    }

    return new Promise<number>((resolve) => {
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
        onChunk(`buildflow: ${err instanceof Error ? err.message : String(err)}\r\n`)
        done(127)
        return
      }
      state.aiProcs.set(node.id, proc)
      proc.onData(onChunk)
      proc.onExit(({ exitCode, signal }) => {
        done(exitCode === 0 ? (exitCodeFromSignal(signal) ?? 0) : exitCode)
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
        onChunk(`buildflow: ${err instanceof Error ? err.message : String(err)}\r\n`)
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
        onChunk(`buildflow: ${err.message}\r\n`)
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
