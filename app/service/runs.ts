import { errorMessage } from '../shared/jev'
import { randomBytes } from 'crypto'
import type { Pipeline } from '../shared/types'
import type { RemoteWorkspace } from '../electron/sandbox'
import { executePipeline, type RunSummary, type ServiceEvent } from './run'

/** Opens the sandbox for one run from the uploaded snapshot. */
export type OpenWorkspace = (archive: Buffer, signal: AbortSignal) => Promise<RemoteWorkspace>

export type RunStatus = 'running' | 'passed' | 'failed' | 'cancelled'

export interface RunRecord {
  id: string
  ownerId: string
  pipelineId: string
  pipelineName: string
  status: RunStatus
  createdAt: string
  finishedAt?: string
  summary?: RunSummary
  /** Events kept for SSE replay; each id is the monotonic SSE event id. */
  events: { id: number; event: ServiceEvent }[]
  nextEventId: number
  outputBytes: number
}

export type Listener = (index: number, event: ServiceEvent) => void

/** Late subscribers can replay this much output; live subscribers always get everything. */
const OUTPUT_REPLAY_LIMIT = 5 * 1024 * 1024

const REPORT_TAIL = 800

/** What the sandbox reported for a finished run, as a few console lines. */
function runReport(record: RunRecord): string {
  const lines = [`[run ${record.id}] ${record.pipelineName}: ${record.status}`]
  for (const step of record.summary?.steps ?? []) {
    const state = step.skipped ? 'skipped' : `exit ${step.code}`
    lines.push(`  ${step.nodeId} (${state})`)
    const tail = step.output.trimEnd().slice(-REPORT_TAIL)
    if (tail) lines.push(...tail.split('\n').map((line) => `    | ${line}`))
  }
  return lines.join('\n')
}

export class BusyError extends Error {}

interface Live {
  abort: AbortController
  listeners: Set<Listener>
}

export class RunRegistry {
  private runs = new Map<string, RunRecord>()
  private live = new Map<string, Live>()

  constructor(
    private open: OpenWorkspace,
    private limits: { maxActive: number; retentionMs: number; inUse?: () => number },
    private log: (line: string) => void = console.log
  ) {}

  /** Start a run in the background. Throws BusyError when too many runs are active. */
  start(ownerId: string, pipeline: Pipeline, archive: Buffer): RunRecord {
    if ((this.limits.inUse?.() ?? this.live.size) >= this.limits.maxActive) throw new BusyError('Too many runs in progress')
    const record: RunRecord = {
      id: randomBytes(8).toString('hex'),
      ownerId,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      status: 'running',
      createdAt: new Date().toISOString(),
      events: [],
      nextEventId: 0,
      outputBytes: 0
    }
    this.runs.set(record.id, record)
    this.live.set(record.id, { abort: new AbortController(), listeners: new Set() })
    this.push(record, {
      type: 'start',
      runId: record.id,
      pipelineId: pipeline.id,
      steps: pipeline.nodes.length,
      at: Date.now()
    })
    void this.execute(record, pipeline, archive)
    return record
  }

  get(id: string, ownerId: string): RunRecord | undefined {
    const record = this.runs.get(id)
    return record?.ownerId === ownerId ? record : undefined
  }

  cancel(id: string): void {
    this.live.get(id)?.abort.abort()
  }

  cancelAll(): void {
    for (const { abort } of this.live.values()) abort.abort()
  }

  /** Whether any run is still going, so shutdown can wait for sandboxes to stop. */
  get active(): number {
    return this.live.size
  }

  /** Attach a listener for events from now on. Returns an unsubscribe, or null when the run is over. */
  subscribe(id: string, listener: Listener): (() => void) | null {
    const live = this.live.get(id)
    if (!live) return null
    live.listeners.add(listener)
    return () => live.listeners.delete(listener)
  }

  private push(record: RunRecord, event: ServiceEvent): void {
    const id = record.nextEventId++
    const isOutput = event.type === 'output'
    if (!isOutput || record.outputBytes < OUTPUT_REPLAY_LIMIT) {
      record.events.push({ id, event })
      if (isOutput) record.outputBytes += event.chunk.length
    }
    for (const listener of this.live.get(record.id)?.listeners ?? []) listener(id, event)
  }

  private async execute(record: RunRecord, pipeline: Pipeline, archive: Buffer): Promise<void> {
    const { abort } = this.live.get(record.id) as Live
    const emit = (event: ServiceEvent): void => this.push(record, event)
    let summary: RunSummary = { ok: false, steps: [] }
    let workspace: RemoteWorkspace | undefined
    try {
      workspace = await this.open(archive, abort.signal)
      summary = await executePipeline(pipeline, workspace, emit, abort.signal)
    } catch (error) {
      if (!abort.signal.aborted) emit({ type: 'error', message: errorMessage(error) })
    } finally {
      await workspace?.close()
      this.log(`[run ${record.id}] sandbox stopped`)
    }
    const cancelled = abort.signal.aborted
    record.summary = summary
    record.status = cancelled ? 'cancelled' : summary.ok ? 'passed' : 'failed'
    record.finishedAt = new Date().toISOString()
    emit({
      type: 'end',
      ok: summary.ok,
      ...(cancelled ? { cancelled } : {}),
      ...(summary.failedNodeId ? { failedNodeId: summary.failedNodeId } : {})
    })
    this.log(runReport(record))
    this.live.delete(record.id)
    setTimeout(() => this.runs.delete(record.id), this.limits.retentionMs).unref()
  }
}
