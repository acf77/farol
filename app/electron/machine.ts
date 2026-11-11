import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  attachScript,
  installScript,
  machineLabel,
  parseProbe,
  probeProblem,
  probeScript,
  remoteCommand,
  sshArgs,
  sshDiagnostics,
  type MachineConfig,
  type MachineFrame,
  type MachineStatus,
  type ProbeResult
} from '../shared/machine'
import { decodeFrame, encodeFrame, splitLines } from './machine-wire'

/**
 * The desktop end of a **Remote machine**: one SSH connection to a Farol
 * server on that machine, carrying backend calls and events as JSON lines.
 *
 * Connecting probes the machine (node, git), installs this build of the
 * server the first time, then attaches. A dropped connection retries with
 * backoff until `disconnect()`; the server and its agents keep running on
 * the remote in the meantime.
 */
export interface MachineOptions {
  /** Directory holding the built server (`out/server`). */
  bundleDir: string
  version: string
  onEvent: (channel: string, payload: unknown) => void
  onStatus: (status: MachineStatus) => void
  /** The `ssh` binary; tests point this at a stand-in. */
  sshPath?: string
  /** Where SSH keeps the shared connection socket. Must be short: Unix sockets cap their path length. */
  controlDir?: string
}

const CALL_WAIT_MS = 20_000
const HELLO_TIMEOUT_MS = 30_000
const MAX_BACKOFF_MS = 30_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

function findSsh(): string {
  for (const candidate of ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh']) {
    if (fs.existsSync(candidate)) return candidate
  }
  return 'ssh'
}

function findTar(): string {
  for (const candidate of ['/usr/bin/tar', '/bin/tar']) {
    if (fs.existsSync(candidate)) return candidate
  }
  return 'tar'
}

/** Version plus a hash of the bundle, so a dev build with the same version still reinstalls. */
export function bundleBuildId(bundleDir: string, version: string): string {
  const hash = createHash('sha256')
  for (const name of fs.readdirSync(bundleDir).sort()) {
    if (!/\.(js|json)$/.test(name)) continue
    hash.update(name)
    hash.update(fs.readFileSync(path.join(bundleDir, name)))
  }
  return `${version.replace(/[^A-Za-z0-9.-]/g, '_')}-${hash.digest('hex').slice(0, 10)}`
}

export class MachineConnection {
  private config: MachineConfig | null = null
  private current: MachineStatus = { state: 'off', config: null }
  private proc: ChildProcess | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private retryTimer: NodeJS.Timeout | null = null
  private backoff = 1000
  /** Bumped by every connect/disconnect, so a stale attempt stops instead of racing a newer one. */
  private generation = 0
  private waiters = new Set<() => void>()
  private readonly ssh: string
  private readonly controlPath: string

  constructor(private opts: MachineOptions) {
    this.ssh = opts.sshPath ?? findSsh()
    // %C is a hash of host, port and user: one shared connection per machine.
    this.controlPath = path.join(opts.controlDir ?? (process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'farol-ssh-%C')
  }

  get status(): MachineStatus {
    return this.current
  }

  /** True while a Remote machine is chosen, connected or not: backend calls belong to it. */
  get active(): boolean {
    return this.config !== null
  }

  get connected(): boolean {
    return this.current.state === 'connected'
  }

  private setStatus(next: Omit<MachineStatus, 'config'>): void {
    this.current = { ...next, config: this.config }
    this.opts.onStatus(this.current)
    if (next.state === 'connected') {
      for (const wake of this.waiters) wake()
      this.waiters.clear()
    }
  }

  /** Start using `config`, replacing any previous machine. Resolves once connected, rejects with the reason it could not. */
  async connect(config: MachineConfig): Promise<void> {
    this.teardown()
    this.config = config
    this.backoff = 1000
    const generation = ++this.generation
    await this.attempt(generation, false)
  }

  /** Stop using the Remote machine. Its server keeps running there. */
  disconnect(): void {
    this.generation++
    this.teardown()
    this.config = null
    this.setStatus({ state: 'off' })
  }

  private teardown(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const proc = this.proc
    this.proc = null
    proc?.kill()
    this.failPending('Disconnected from the remote machine.')
  }

  private failPending(message: string): void {
    for (const p of this.pending.values()) p.reject(new Error(message))
    this.pending.clear()
  }

  private async attempt(generation: number, retrying: boolean): Promise<void> {
    const config = this.config
    if (!config) return
    const label = machineLabel(config)
    try {
      this.setStatus({ state: retrying ? 'reconnecting' : 'connecting', message: `Connecting to ${label}…` })
      const buildId = bundleBuildId(this.opts.bundleDir, this.opts.version)
      const probe = await this.probe(config, buildId)
      if (generation !== this.generation) return
      const problem = probeProblem(probe)
      if (problem) throw new Error(problem)
      if (!probe.ready) {
        this.setStatus({ state: 'connecting', message: `Installing Farol on ${label} (first time takes a minute)…` })
        await this.install(config, buildId)
        if (generation !== this.generation) return
      }
      await this.attach(config, buildId, probe, generation)
      this.backoff = 1000
    } catch (err) {
      if (generation !== this.generation) return
      const message = err instanceof Error ? err.message : String(err)
      const authUrl = (err as { authUrl?: string }).authUrl
      if (!retrying) {
        // The first attempt reports straight back to whoever asked to connect.
        this.setStatus({ state: 'error', message, ...(authUrl ? { authUrl } : {}) })
        this.scheduleRetry(generation)
        throw err
      }
      this.setStatus({ state: 'reconnecting', message, ...(authUrl ? { authUrl } : {}) })
      this.scheduleRetry(generation)
    }
  }

  private scheduleRetry(generation: number): void {
    if (generation !== this.generation || !this.config) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const delay = this.backoff * (0.8 + Math.random() * 0.4)
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.attempt(generation, true).catch(() => undefined)
    }, delay)
  }

  /** Run `script` on the machine and collect its output. */
  private run(config: MachineConfig, script: string, stdin?: NodeJS.ReadableStream, timeoutMs = 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ssh, [...sshArgs(config, this.controlPath), remoteCommand(script)], {
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
      })
      let out = ''
      let err = ''
      child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr?.on('data', (d: Buffer) => (err += d.toString()))
      if (stdin && child.stdin) stdin.pipe(child.stdin)
      const timer = setTimeout(() => child.kill(), timeoutMs)
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(new Error(`Could not run ssh: ${e.message}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) return resolve(out)
        const diag = sshDiagnostics(err)
        reject(Object.assign(new Error(diag.message || `ssh exited with code ${code}`), { authUrl: diag.authUrl }))
      })
    })
  }

  private async probe(config: MachineConfig, buildId: string): Promise<ProbeResult> {
    return parseProbe(await this.run(config, probeScript(buildId), undefined, 30_000))
  }

  private async install(config: MachineConfig, buildId: string): Promise<void> {
    const tar = spawn(findTar(), ['-czf', '-', '-C', this.opts.bundleDir, '.'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const out = await this.run(config, installScript(buildId), tar.stdout ?? undefined, 10 * 60_000)
    if (!out.includes('FAROL_INSTALLED=1')) throw new Error('Installing Farol on the remote machine did not finish.')
  }

  private attach(config: MachineConfig, buildId: string, probe: ProbeResult, generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ssh, [...sshArgs(config, this.controlPath), remoteCommand(attachScript(buildId, probe.node))], {
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.proc = child
      let buffer = ''
      let stderr = ''
      let hello = false
      const timer = setTimeout(() => {
        if (!hello) child.kill()
      }, HELLO_TIMEOUT_MS)

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        const { lines, rest } = splitLines(buffer + chunk)
        buffer = rest
        for (const line of lines) {
          const frame = decodeFrame(line)
          if (!frame) continue
          if (frame.t === 'hello' && !hello) {
            hello = true
            clearTimeout(timer)
            this.setStatus({
              state: 'connected',
              home: frame.home,
              message: frame.pty
                ? `Connected to ${machineLabel(config)}.`
                : `Connected to ${machineLabel(config)}. Terminals and pipeline steps are off: node-pty did not install there.`
            })
            resolve()
          } else this.onFrame(frame)
        }
      })
      child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))
      child.on('error', (e) => reject(new Error(`Could not run ssh: ${e.message}`)))
      child.on('close', (code) => {
        clearTimeout(timer)
        if (this.proc === child) this.proc = null
        if (generation !== this.generation) return
        this.failPending(`Lost the connection to ${machineLabel(config)}.`)
        const diag = sshDiagnostics(stderr)
        if (!hello) {
          reject(Object.assign(new Error(diag.message || `The Farol server on ${machineLabel(config)} did not answer (exit ${code}).`), { authUrl: diag.authUrl }))
          return
        }
        this.setStatus({ state: 'reconnecting', message: `Lost the connection to ${machineLabel(config)}. Reconnecting…` })
        this.scheduleRetry(generation)
      })
    })
  }

  private onFrame(frame: MachineFrame): void {
    if (frame.t === 'ev') {
      this.opts.onEvent(frame.ch, frame.payload)
      return
    }
    if (frame.t !== 'ret') return
    const p = this.pending.get(frame.id)
    if (!p) return
    this.pending.delete(frame.id)
    if (frame.ok) p.resolve(frame.value)
    else p.reject(new Error(frame.error))
  }

  /** Wait (briefly) for a connection, so a call made while reconnecting still goes through. */
  private whenConnected(): Promise<void> {
    if (this.connected) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(wake)
        const label = this.config ? machineLabel(this.config) : 'the remote machine'
        reject(new Error(`Not connected to ${label}. ${this.current.message ?? ''}`.trim()))
      }, CALL_WAIT_MS)
      const wake = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.waiters.add(wake)
    })
  }

  /** Call a backend channel on the Remote machine. */
  async call(channel: string, args: unknown[]): Promise<unknown> {
    await this.whenConnected()
    const proc = this.proc
    if (!proc?.stdin) throw new Error('Not connected to the remote machine.')
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      proc.stdin!.write(encodeFrame({ t: 'call', id, ch: channel, args }) + '\n')
    })
  }
}
