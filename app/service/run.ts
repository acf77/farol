import type { Pipeline, PipelineNode, PipelineStepResult } from '../shared/types'
import { ancestorVars, descendants, expandVars, nodeGate, quoteShellArg, readyIds, topoSort } from '../shared/graph'
import { appendTail } from '../shared/terminal'
import type { RemoteWorkspace } from '../electron/sandbox'

/**
 * Runs a pipeline's shell steps in a sandbox: ready nodes start together, a
 * gated failure skips its descendants, and `${name}` expands from ancestor
 * outputs — the same rules as the desktop runner, minus AI steps.
 */

export type ServiceEvent =
  | { type: 'start'; runId: string; pipelineId: string; steps: number; at: number }
  | { type: 'step-start'; nodeId: string }
  | { type: 'output'; nodeId: string; chunk: string }
  | { type: 'step-end'; nodeId: string; ok: boolean; code: number; durationMs: number; skipped?: boolean }
  | { type: 'error'; message: string }
  | { type: 'end'; ok: boolean; cancelled?: boolean; failedNodeId?: string }

export interface RunSummary {
  ok: boolean
  cancelled?: boolean
  failedNodeId?: string
  steps: PipelineStepResult[]
}

const OUTPUT_LIMIT = 64_000
const CANCELLED = 130

class Execution {
  private done = new Set<string>()
  private skipped = new Set<string>()
  private started = new Set<string>()
  private results = new Map<string, PipelineStepResult>()
  private outputs: Record<string, string> = {}
  private failedNodeId?: string

  constructor(
    private nodes: PipelineNode[],
    private workspace: RemoteWorkspace,
    private emit: (event: ServiceEvent) => void,
    private signal: AbortSignal
  ) {}

  async run(): Promise<RunSummary> {
    const inflight = new Map<string, Promise<void>>()
    this.startReady(inflight)
    while (inflight.size) {
      await Promise.race(inflight.values())
      this.startReady(inflight)
    }
    for (const node of this.nodes) this.skip(node.id, this.signal.aborted ? CANCELLED : 0)
    return this.summary()
  }

  private startReady(inflight: Map<string, Promise<void>>): void {
    if (this.signal.aborted) return
    for (const id of readyIds(this.nodes, this.done, this.skipped, this.started)) {
      this.started.add(id)
      const node = this.nodes.find((n) => n.id === id) as PipelineNode
      inflight.set(id, this.step(node).finally(() => inflight.delete(id)))
    }
  }

  private summary(): RunSummary {
    const cancelled = this.signal.aborted
    return {
      ok: this.failedNodeId === undefined && !cancelled,
      ...(cancelled ? { cancelled } : {}),
      ...(this.failedNodeId ? { failedNodeId: this.failedNodeId } : {}),
      steps: this.nodes.map((n) => this.results.get(n.id) as PipelineStepResult)
    }
  }

  private skip(id: string, code: number): void {
    if (this.results.has(id)) return
    this.skipped.add(id)
    this.results.set(id, { nodeId: id, ok: false, code, skipped: true, output: '' })
    this.emit({ type: 'step-end', nodeId: id, ok: false, code, durationMs: 0, skipped: true })
  }

  private async step(node: PipelineNode): Promise<void> {
    this.emit({ type: 'step-start', nodeId: node.id })
    const startedAt = Date.now()
    const vars = ancestorVars(this.nodes, node.id, this.outputs, this.results)
    const code = await this.exec(node.id, expandVars(node.cmd, vars, { quote: quoteShellArg }))
    const ok = code === 0 && !this.signal.aborted
    this.results.set(node.id, { nodeId: node.id, ok, code, output: this.outputs[node.id] ?? '' })
    this.emit({ type: 'step-end', nodeId: node.id, ok, code, durationMs: Date.now() - startedAt })
    this.done.add(node.id)
    if (ok || this.signal.aborted) return
    this.failedNodeId ??= node.id
    if (nodeGate(node)) for (const id of descendants(this.nodes, node.id)) this.skip(id, 0)
  }

  private async exec(nodeId: string, cmd: string): Promise<number> {
    try {
      return await this.workspace.exec(cmd, (chunk) => this.output(nodeId, chunk))
    } catch (error) {
      if (this.signal.aborted) return CANCELLED
      this.output(nodeId, `farol: ${error instanceof Error ? error.message : String(error)}\n`)
      return 127
    }
  }

  private output(nodeId: string, chunk: string): void {
    this.outputs[nodeId] = appendTail(this.outputs[nodeId] ?? '', chunk, OUTPUT_LIMIT)
    this.emit({ type: 'output', nodeId, chunk })
  }
}

/** Steps a sandbox cannot run: agent CLIs and their logins live on a developer machine. */
export function aiStepNames(pipeline: Pipeline): string[] {
  return pipeline.nodes.filter((n) => n.type === 'ai').map((n) => n.name || n.id)
}

export function executePipeline(
  pipeline: Pipeline,
  workspace: RemoteWorkspace,
  emit: (event: ServiceEvent) => void,
  signal: AbortSignal
): Promise<RunSummary> {
  const nodes = topoSort(pipeline.nodes) ?? pipeline.nodes
  return new Execution(nodes, workspace, emit, signal).run()
}
