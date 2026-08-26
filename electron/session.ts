import * as pty from 'node-pty'
import os from 'os'
import { killPty } from './kill'
import {
  execScript,
  feedMarks,
  initScript,
  loginArgs,
  shellFamily,
  type ShellFamily
} from './protocol'

/**
 * A long-lived shell session on a real PTY, used to drive pipeline steps.
 *
 * The machine's own login shell is started so PATH, aliases and tools match a
 * Terminal window. Command completion is detected with a printf marker, not
 * PS1 — oh-my-zsh, Starship and Powerlevel10k overwrite the prompt, which is
 * why a step like `echo` used to hang forever with an empty log.
 */

const isWindows = process.platform === 'win32'
const READY_MS = 15000

export function defaultShell(): string {
  if (isWindows) return process.env.COMSPEC || 'powershell.exe'
  if (process.env.SHELL) return process.env.SHELL
  try {
    const shell = os.userInfo().shell
    if (shell) return shell
  } catch {
    /* fall through */
  }
  return '/bin/sh'
}

export function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return env
}

/** Pipeline sessions: skip pagers and p10k instant prompt, which steal stdin. */
export function pipelineEnv(): Record<string, string> {
  const env = shellEnv()
  env.PAGER = 'cat'
  env.GIT_PAGER = 'cat'
  env.POWERLEVEL9K_INSTANT_PROMPT = 'off'
  return env
}

export interface SessionOptions {
  cwd: string
  cols?: number
  onData: (chunk: string) => void
  onEnd: (code: number) => void
}

interface Waiter {
  resolve: (r: { code: number; cwd: string }) => void
}

export class PtySession {
  readonly proc: pty.IPty
  cwd: string
  private readonly family: ShellFamily
  private buf = ''
  private started = false
  private waiter: Waiter | null = null
  private queue: Array<() => void> = []
  private alive = true
  private readyResolvers: Array<(ok: boolean) => void> = []

  constructor(private opts: SessionOptions) {
    this.cwd = opts.cwd
    const shell = defaultShell()
    this.family = shellFamily(shell)
    this.proc = pty.spawn(shell, loginArgs(this.family), {
      name: 'xterm-256color',
      cols: Math.max(20, Math.min(400, Math.floor(opts.cols ?? 100))),
      rows: 40,
      cwd: opts.cwd,
      env: pipelineEnv()
    })
    this.proc.onData((chunk) => this.consume(chunk))
    this.proc.onExit(({ exitCode }) => {
      this.alive = false
      this.flushReady(false)
      const waiter = this.waiter
      this.waiter = null
      waiter?.resolve({ code: exitCode, cwd: this.cwd })
      const queued = this.queue.splice(0)
      for (const fn of queued) fn()
      this.opts.onEnd(exitCode)
    })
    this.proc.write(initScript(this.family))
  }

  get isAlive(): boolean {
    return this.alive
  }

  /** Resolves true once the shell has printed the ready marker. */
  whenReady(ms = READY_MS): Promise<boolean> {
    if (this.started) return Promise.resolve(true)
    if (!this.alive) return Promise.resolve(false)
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.readyResolvers = this.readyResolvers.filter((r) => r !== done)
        resolve(false)
      }, ms)
      const done = (ok: boolean): void => {
        clearTimeout(t)
        resolve(ok)
      }
      this.readyResolvers.push(done)
    })
  }

  private flushReady(ok: boolean): void {
    const rs = this.readyResolvers.splice(0)
    for (const r of rs) r(ok)
  }

  private consume(chunk: string): void {
    this.buf += chunk
    const { text, marks, rest } = feedMarks(this.buf)
    this.buf = rest
    if (text && this.started) this.opts.onData(text)
    for (const mark of marks) this.onMark(mark)
  }

  private onMark(mark: { code: number; cwd: string }): void {
    if (mark.cwd) this.cwd = mark.cwd
    if (!this.started) {
      this.started = true
      this.flushReady(true)
      const next = this.queue.shift()
      next?.()
      return
    }
    const waiter = this.waiter
    this.waiter = null
    waiter?.resolve({ code: mark.code, cwd: this.cwd })
    if (!this.waiter) this.queue.shift()?.()
  }

  exec(cmd: string): Promise<{ code: number; cwd: string }> {
    return new Promise((resolve) => {
      const go = (): void => {
        if (!this.alive) {
          resolve({ code: 127, cwd: this.cwd })
          return
        }
        this.waiter = { resolve }
        this.proc.write(execScript(this.family, cmd))
      }
      if (this.started && !this.waiter) go()
      else this.queue.push(go)
    })
  }

  write(data: string): void {
    if (this.alive) this.proc.write(data)
  }

  interrupt(): void {
    if (this.alive) this.proc.write('\x03')
  }

  resize(cols: number): void {
    if (!this.alive) return
    try {
      this.proc.resize(Math.max(20, Math.min(400, Math.floor(cols))), 40)
    } catch {
      /* the process may have just exited */
    }
  }

  kill(): void {
    if (!this.alive) return
    this.alive = false
    this.flushReady(false)
    const waiter = this.waiter
    this.waiter = null
    waiter?.resolve({ code: 130, cwd: this.cwd })
    const queued = this.queue.splice(0)
    for (const fn of queued) fn()
    killPty(this.proc)
  }
}
