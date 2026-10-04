import { errorMessage } from '../shared/jev'
import { createHash, randomBytes } from 'crypto'
import { RUN_RESULT_SCHEMA, RUN_STEP_OUTPUT_LIMIT, type RunResult } from '../shared/run-result'
import { appendTail } from '../shared/terminal'
import type { Pipeline } from '../shared/types'
import type { RemoteWorkspace } from '../electron/sandbox'
import { executePipeline, type RunSummary, type ServiceEvent } from './run'

/** Opens the sandbox for one run from the uploaded snapshot. */
export type OpenWorkspace = (archive: Buffer, signal: AbortSignal) => Promise<RemoteWorkspace>

export interface RunRecord {
  id: string
  ownerId: string
  /** What `GET /v1/runs/:id` returns, kept current as events arrive. */
  result: RunResult
  /** Characters each step has printed, to tell when its kept output is only the tail. */
  stepOutputSeen: Record<string, number>
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
function runReport({ id, result }: RunRecord): string {
  const lines = [`[run ${id}] ${result.pipeline.name}: ${result.status}${result.error ? ` (${result.error})` : ''}`]
  for (const step of result.steps) {
    const state = step.status === 'skipped' ? 'skipped' : `exit ${step.exitCode ?? '-'}`
    lines.push(`  ${step.id} (${state})`)
    const tail = step.output.trimEnd().slice(-REPORT_TAIL)
    if (tail) lines.push(...tail.split('\n').map((line) => `    | ${line}`))
  }
  return lines.join('\n')
}

/** Fold one event into the run's result. */
function track(record: RunRecord, event: ServiceEvent): void {
  const { result } = record
  const step = 'nodeId' in event ? result.steps.find((s) => s.id === event.nodeId) : undefined
  switch (event.type) {
    case 'step-start':
      if (step) step.status = 'running'
      break
    case 'output':
      if (!step) break
      step.output = appendTail(step.output, event.chunk, RUN_STEP_OUTPUT_LIMIT)
      record.stepOutputSeen[step.id] = (record.stepOutputSeen[step.id] ?? 0) + event.chunk.length
      step.outputTruncated = record.stepOutputSeen[step.id] > RUN_STEP_OUTPUT_LIMIT
      break
    case 'step-end':
      if (!step) break
      step.status = event.skipped ? 'skipped' : event.ok ? 'passed' : 'failed'
      if (!event.skipped) Object.assign(step, { exitCode: event.code, durationMs: event.durationMs })
      break
    case 'error':
      result.error ??= event.message
      break
    case 'end':
      if (event.failedNodeId) result.failedStepId = event.failedNodeId
      break
  }
}

export class BusyError extends Error {}

/** Runs and workspaces draw on one pool of sandboxes, with a share per owner. */
export interface PoolLimits {
  maxActive: number
  /** Sandboxes in use or starting across the pool. */
  inUse: () => number
  /** Most sandboxes one owner may hold at once; unlimited when unset. */
  maxPerOwner?: number
  ownerInUse?: (ownerId: string) => number
}

/** Throw BusyError when the pool, or the owner's share of it, is full. */
export function checkPool(limits: PoolLimits, ownerId: string): void {
  if (limits.inUse() >= limits.maxActive) throw new BusyError('Too many sandboxes in use; try again shortly')
  if (limits.maxPerOwner !== undefined && (limits.ownerInUse?.(ownerId) ?? 0) >= limits.maxPerOwner) {
    throw new BusyError(`You already have ${limits.maxPerOwner} sandbox${limits.maxPerOwner === 1 ? '' : 'es'} running`)
  }
}

interface Live {
  abort: AbortController
  listeners: Set<Listener>
}

export class RunRegistry {
  private runs = new Map<string, RunRecord>()
  private live = new Map<string, Live>()

  constructor(
    private open: OpenWorkspace,
    private limits: Omit<PoolLimits, 'inUse'> & {
      inUse?: () => number
      retentionMs: number
      /** A run still going after this long is stopped and fails. */
      maxDurationMs?: number
    },
    private log: (line: string) => void = console.log
  ) {}

  /** Start a run in the background. Throws BusyError when too many runs are active. */
  start(ownerId: string, pipeline: Pipeline, archive: Buffer): RunRecord {
    checkPool(
      {
        ...this.limits,
        inUse: this.limits.inUse ?? (() => this.live.size),
        ownerInUse: this.limits.ownerInUse ?? ((owner) => this.activeFor(owner))
      },
      ownerId
    )
    const id = randomBytes(8).toString('hex')
    const record: RunRecord = {
      id,
      ownerId,
      result: {
        schema: RUN_RESULT_SCHEMA,
        runId: id,
        status: 'running',
        source: { kind: 'snapshot', sha256: createHash('sha256').update(archive).digest('hex'), bytes: archive.length },
        pipeline: { id: pipeline.id, name: pipeline.name },
        createdAt: new Date().toISOString(),
        steps: pipeline.nodes.map((n) => ({ id: n.id, name: n.name || n.id, status: 'pending', output: '', outputTruncated: false }))
      },
      stepOutputSeen: {},
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

  /** Runs the owner has going. */
  activeFor(ownerId: string): number {
    let count = 0
    for (const id of this.live.keys()) if (this.runs.get(id)?.ownerId === ownerId) count++
    return count
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
    track(record, event)
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
    let timedOut = false
    const limit = this.limits.maxDurationMs
    const deadline = limit
      ? setTimeout(() => {
          timedOut = true
          emit({ type: 'error', message: `Run stopped after the ${Math.round(limit / 60_000)}-minute limit` })
          abort.abort()
        }, limit)
      : undefined
    try {
      workspace = await this.open(archive, abort.signal)
      summary = await executePipeline(pipeline, workspace, emit, abort.signal)
    } catch (error) {
      if (!abort.signal.aborted) emit({ type: 'error', message: errorMessage(error) })
    } finally {
      clearTimeout(deadline)
      await workspace?.close()
      this.log(`[run ${record.id}] sandbox stopped`)
    }
    const cancelled = abort.signal.aborted && !timedOut
    if (timedOut) summary = { ...summary, ok: false, cancelled: undefined }
    record.result.status = cancelled ? 'cancelled' : summary.ok ? 'passed' : 'failed'
    record.result.finishedAt = new Date().toISOString()
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
