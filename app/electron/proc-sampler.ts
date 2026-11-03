import { execFile, spawn, type ChildProcess } from 'child_process'
import { basename } from 'path'
import { attribute, snapshotOf, type ProcInfo, type ProcSnapshot, type SessionUsage } from '../shared/proc'
import type { ProcRegistry } from './proc-sessions'

const VISIBLE_MS = 3000
const HIDDEN_MS = 15000
const HELPER_TIMEOUT_MS = 3000

export interface Sample {
  procs: ProcInfo[]
  /** True when the numbers are RSS from `ps`, not the physical footprint. */
  approximate: boolean
  /** The listing could not be read. `procs` is empty then, which does not mean nothing runs. */
  failed?: true
}

interface HelperRow {
  pid: number
  ppid: number
  pgid: number
  uid: number
  sec: number
  usec: number
  fp: number
  cpu: number
  name: string
  cwd?: string
  args?: string
}

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+(.+)$/

/** `ps` rows: RSS in KiB, `%cpu` over the process lifetime. No working directory. */
export function parsePs(out: string): ProcInfo[] {
  const procs: ProcInfo[] = []
  for (const line of out.split('\n')) {
    const m = PS_ROW.exec(line)
    if (!m) continue
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      uid: Number(m[4]),
      footprint: Number(m[5]) * 1024,
      cpu: Number(m[6]),
      startMs: Date.parse(m[7]),
      name: basename(m[8].trim())
    })
  }
  return procs
}

/** `ps` and `lsof` normally answer at once; a stalled one is killed rather than waited for. */
const INSPECT_TIMEOUT_MS = 5000

function psSample(signal: AbortSignal): Promise<Sample> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,uid=,rss=,%cpu=,lstart=,comm='],
      { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024, timeout: INSPECT_TIMEOUT_MS, signal },
      (error, stdout) => resolve(error ? { procs: [], approximate: true, failed: true } : { procs: parsePs(stdout), approximate: true })
    )
  })
}

/** Listening TCP ports for these pids, from one `lsof` call. */
export function listPorts(pids: number[], signal?: AbortSignal): Promise<Map<number, number[]>> {
  const ports = new Map<number, number[]>()
  const safe = pids.filter((pid) => Number.isInteger(pid) && pid > 0)
  if (!safe.length) return Promise.resolve(ports)
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', safe.join(','), '-Fpn'],
      { maxBuffer: 4 * 1024 * 1024, timeout: INSPECT_TIMEOUT_MS, signal },
      (_error, stdout) => {
        let pid = 0
        for (const line of (stdout ?? '').split('\n')) {
          if (line.startsWith('p')) pid = Number(line.slice(1))
          else if (line.startsWith('n') && pid) {
            const port = Number(line.slice(line.lastIndexOf(':') + 1))
            if (port > 0) ports.set(pid, [...new Set([...(ports.get(pid) ?? []), port])])
          }
        }
        resolve(ports)
      }
    )
  })
}

export interface SamplerOptions {
  registry: ProcRegistry
  /** The `procsnap` helper; without it, or when it fails, `ps` stands in. */
  helperPath: string
  isVisible: () => boolean
  onSnapshot: (snapshot: ProcSnapshot) => void
  /** Called for each done session whose worktree is gone. */
  onWorktreeGone?: (sessionId: string) => void
  worktreeExists?: (path: string) => boolean
  uid: number
}

/**
 * Samples the process table with one bulk read per tick: every 3 s while the
 * window shows, every 15 s otherwise.
 */
export class ProcSampler {
  latest: ProcSnapshot = { at: 0, approximate: false, totalFootprint: 0, worktrees: [] }
  private helper: ChildProcess | null = null
  private helperBroken = false
  private buffer = ''
  private pending: ((line: string | null) => void) | null = null
  private cpuMarks = new Map<string, { ns: number; at: number }>()
  private queue: Promise<void> = Promise.resolve()
  /** Aborted by `stop()`, which ends any `ps` or `lsof` still running. */
  private abort = new AbortController()
  private timer: NodeJS.Timeout | undefined
  private stopped = true
  /** Set by `stop()`: queued samples end at once and the helper is not started again. */
  private closed = false

  constructor(private opts: SamplerOptions) {}

  /** Lets a caller's own `lsof` end with the sampler. */
  get signal(): AbortSignal {
    return this.abort.signal
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.closed = false
    this.abort = new AbortController()
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    this.closed = true
    this.abort.abort()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.stopHelper()
  }

  private stopHelper(): void {
    const helper = this.helper
    this.helper = null
    this.pending?.(null)
    this.pending = null
    helper?.kill()
  }

  private ensureHelper(): ChildProcess | null {
    if (this.helper) return this.helper
    if (this.helperBroken || process.platform !== 'darwin') return null
    try {
      const helper = spawn(this.opts.helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'] })
      this.buffer = ''
      helper.stdout?.setEncoding('utf8')
      helper.stdout?.on('data', (chunk: string) => {
        this.buffer += chunk
        const end = this.buffer.indexOf('\n')
        if (end < 0) return
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        this.pending?.(line)
        this.pending = null
      })
      helper.stdin?.on('error', () => undefined)
      helper.on('error', () => {
        this.helperBroken = true
        this.stopHelper()
      })
      helper.on('exit', () => {
        if (this.helper === helper) this.stopHelper()
      })
      this.helper = helper
      return helper
    } catch {
      this.helperBroken = true
      return null
    }
  }

  private askHelper(): Promise<string | null> {
    const helper = this.ensureHelper()
    if (!helper?.stdin?.writable) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending = null
        this.stopHelper()
        resolve(null)
      }, HELPER_TIMEOUT_MS)
      this.pending = (line) => {
        clearTimeout(timer)
        resolve(line)
      }
      helper.stdin?.write('tick\n')
    })
  }

  private fromHelper(line: string, at: number): ProcInfo[] | null {
    let rows: HelperRow[]
    try {
      rows = (JSON.parse(line) as { p: HelperRow[] }).p
    } catch {
      return null
    }
    const marks = new Map<string, { ns: number; at: number }>()
    const procs = rows.map((row): ProcInfo => {
      const startMs = row.sec * 1000 + Math.floor(row.usec / 1000)
      const key = `${row.pid}:${startMs}`
      const prev = this.cpuMarks.get(key)
      marks.set(key, { ns: row.cpu, at })
      const cpu = prev && at > prev.at ? ((row.cpu - prev.ns) / ((at - prev.at) * 1e6)) * 100 : 0
      return {
        pid: row.pid,
        ppid: row.ppid,
        pgid: row.pgid,
        uid: row.uid,
        startMs,
        footprint: row.fp,
        cpu: Math.max(0, cpu),
        name: row.name,
        cwd: row.cwd,
        args: row.args
      }
    })
    this.cpuMarks = marks
    return procs
  }

  /** One fresh listing: the helper when it works, `ps` when it does not. Calls queue, as the helper answers one at a time. */
  sample(): Promise<Sample> {
    const run = this.queue.then(async (): Promise<Sample> => {
      if (this.closed) return { procs: [], approximate: true, failed: true }
      const line = await this.askHelper()
      const procs = line ? this.fromHelper(line, Date.now()) : null
      return procs ? { procs, approximate: false } : psSample(this.abort.signal)
    })
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** Done sessions with nothing left are forgotten; those whose worktree is gone are reported. */
  private sweep(usages: SessionUsage[]): void {
    for (const usage of usages) {
      if (usage.state !== 'done') continue
      if (!usage.procs.length) this.opts.registry.remove(usage.sessionId)
      else if (this.opts.worktreeExists?.(usage.worktree) === false) this.opts.onWorktreeGone?.(usage.sessionId)
    }
  }

  private async measure(): Promise<ProcSnapshot> {
    const sessions = this.opts.registry.list()
    if (!sessions.length) {
      // Nothing to watch: close the helper, and clear what was shown once.
      this.stopHelper()
      return this.latest.worktrees.length ? snapshotOf([], Date.now(), false) : this.latest
    }
    const { procs, approximate, failed } = await this.sample()
    // A listing that failed proves nothing: keep what is tracked and show the last numbers.
    if (failed) return this.latest
    const usages = attribute(procs, sessions, this.opts.uid)
    this.opts.registry.noteSeen(usages)
    this.sweep(usages)
    return snapshotOf(usages, Date.now(), approximate)
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    try {
      this.latest = await this.measure()
      this.opts.onSnapshot(this.latest)
    } catch (err) {
      // Keep the last snapshot; a bad sample must not become an unhandled rejection.
      console.warn('[proc-sampler] sample failed:', err instanceof Error ? err.name : 'unknown')
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.tick(), this.opts.isVisible() ? VISIBLE_MS : HIDDEN_MS)
        this.timer.unref()
      }
    }
  }
}
