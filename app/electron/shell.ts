import * as pty from 'node-pty'
import { execFile } from 'node:child_process'
import { interactiveAiCommand, isAiProvider, type AiProvider } from '../shared/ai'
import { errorMessage } from '../shared/jev'
import type { ShellActivity, ShellCwd, ShellData, ShellExit } from '../shared/types'
import { aiEnv, resolveBin } from './bin'
import { openRouterAgent } from './openrouter-agent'
import { defaultShell, shellEnv } from './session'

/**
 * Shell panes are interactive PTYs forwarded verbatim to xterm.js. A normal
 * pane is the user's login shell. A dedicated agent pane runs that CLI
 * directly — OpenRouter's key is injected only into that process via `aiEnv`.
 *
 * (Pipeline steps are different — they run through the scripted session in
 * `session.ts`, which reports exit codes.)
 */

/** OSC 7 — how a shell announces its working directory to its terminal. */
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const OSC7 = new RegExp(`${ESC}\\]7;file:\\/\\/[^/]*([^${BEL}${ESC}]*)(?:${BEL}|${ESC}\\\\)`, 'g')

function terminalSize(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Math.max(20, Math.min(500, Math.floor(cols))),
    rows: Math.max(5, Math.min(200, Math.floor(rows)))
  }
}

interface Session {
  proc: pty.IPty
  cwd: string
  active: boolean
  activityTimer?: NodeJS.Timeout
  activityChecks: number
}

export class ShellManager {
  private sessions = new Map<string, Session>()
  /** Commands aimed at a pane whose PTY has not started yet. */
  private pending = new Map<string, string[]>()

  constructor(
    private onData: (e: ShellData) => void,
    private onExit: (e: ShellExit) => void,
    private onCwd: (e: ShellCwd) => void,
    private onActivity: (e: ShellActivity) => void
  ) {}

  private setActive(paneId: string, session: Session, active: boolean): void {
    if (session.active === active) return
    session.active = active
    this.onActivity({ paneId, active })
  }

  private stopActivityWatch(session: Session): void {
    if (session.activityTimer) clearInterval(session.activityTimer)
    session.activityTimer = undefined
  }

  private updateActivity(paneId: string, session: Session, error: Error | null, stdout: string): void {
    if (this.sessions.get(paneId) !== session) return
    if (error) {
      session.activityChecks--
      if (session.activityChecks <= 0) this.stopActivityWatch(session)
      return
    }

    const [pgid, foreground] = stdout.trim().split(/\s+/).map(Number)
    if (!Number.isFinite(pgid) || !Number.isFinite(foreground)) return
    const active = foreground > 0 && foreground !== pgid
    const finished = session.active && !active
    this.setActive(paneId, session, active)
    session.activityChecks = active ? 5 : session.activityChecks - 1
    if (finished || session.activityChecks <= 0) this.stopActivityWatch(session)
  }

  private watchActivity(paneId: string, session: Session): void {
    if (process.platform === 'win32' || session.activityTimer) return
    let checking = false
    const check = (): void => {
      if (checking || this.sessions.get(paneId) !== session) return
      checking = true
      execFile('ps', ['-o', 'pgid=,tpgid=', '-p', String(session.proc.pid)], (error, stdout) => {
        checking = false
        this.updateActivity(paneId, session, error, stdout)
      })
    }
    session.activityChecks = 5
    check()
    session.activityTimer = setInterval(check, 400)
  }

  open(paneId: string, cwd: string, cols = 100, rows = 30, provider?: AiProvider): void {
    const existing = this.sessions.get(paneId)
    if (existing) return

    const agent = isAiProvider(provider) ? provider : undefined
    const via = openRouterAgent()
    const command = agent ? interactiveAiCommand(agent, via) : defaultShell()
    const args = agent || process.platform === 'win32' ? [] : ['-il']
    let proc: pty.IPty
    try {
      proc = pty.spawn(agent ? (resolveBin(command) ?? command) : command, args, {
        name: 'xterm-256color',
        ...terminalSize(cols, rows),
        cwd,
        env: agent ? aiEnv(agent, via) : shellEnv()
      })
    } catch (err) {
      const message = errorMessage(err)
      this.onData({ tabId: paneId, chunk: `farol: cannot start ${command}: ${message}\r\n` })
      return
    }

    const session: Session = { proc, cwd, active: false, activityChecks: 0 }
    this.sessions.set(paneId, session)

    // A login shell prints its prompt asynchronously; typing into it before
    // that lands gets eaten, so let it settle before flushing queued commands.
    const queued = this.pending.get(paneId)
    if (queued?.length) {
      this.pending.delete(paneId)
      setTimeout(() => {
        if (this.sessions.get(paneId) !== session) return
        for (const data of queued) session.proc.write(data)
        this.watchActivity(paneId, session)
      }, 400)
    }

    proc.onData((chunk) => {
      // Follow `cd` when the shell reports it; harmless when it doesn't.
      OSC7.lastIndex = 0
      let match: RegExpExecArray | null
      let last: string | null = null
      while ((match = OSC7.exec(chunk))) last = match[1]
      if (last) {
        let next: string
        try {
          next = decodeURIComponent(last)
        } catch {
          next = last
        }
        if (next && next !== session.cwd) {
          session.cwd = next
          this.onCwd({ paneId, cwd: next })
        }
      }
      this.onData({ tabId: paneId, chunk })
    })

    proc.onExit(({ exitCode }) => {
      this.sessions.delete(paneId)
      this.stopActivityWatch(session)
      this.setActive(paneId, session, false)
      this.onExit({ tabId: paneId, code: exitCode, cwd: session.cwd, durationMs: 0, sessionEnded: true })
    })
  }

  /** Keystrokes and pasted text, straight to the PTY. */
  write(paneId: string, data: string): void {
    const session = this.sessions.get(paneId)
    session?.proc.write(data)
    if (session && /[\r\n]/.test(data)) this.watchActivity(paneId, session)
  }

  /**
   * Write on behalf of the app rather than the keyboard. A pane opened a
   * moment ago has no PTY yet, and `write` would drop the data on the floor —
   * so hold it until `open` runs.
   */
  send(paneId: string, data: string): void {
    const session = this.sessions.get(paneId)
    if (session) {
      session.proc.write(data)
      if (/[\r\n]/.test(data)) this.watchActivity(paneId, session)
      return
    }
    const queue = this.pending.get(paneId) ?? []
    if (queue.length >= 32) return
    queue.push(data)
    this.pending.set(paneId, queue)
  }

  resize(paneId: string, cols: number, rows: number): void {
    const session = this.sessions.get(paneId)
    if (!session) return
    try {
      const size = terminalSize(cols, rows)
      session.proc.resize(size.cols, size.rows)
    } catch {
      /* the process may have just exited */
    }
  }

  dispose(paneId: string): void {
    this.pending.delete(paneId)
    const session = this.sessions.get(paneId)
    if (!session) return
    this.sessions.delete(paneId)
    this.stopActivityWatch(session)
    this.setActive(paneId, session, false)
    try {
      session.proc.kill()
    } catch {
      /* already gone */
    }
  }

  disposeAll(): void {
    for (const paneId of this.sessions.keys()) this.dispose(paneId)
  }
}
