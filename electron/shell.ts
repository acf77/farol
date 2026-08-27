import * as pty from 'node-pty'
import type { ShellCwd, ShellData, ShellExit } from '../shared/types'
import { defaultShell, shellEnv } from './session'

/**
 * Shell panes are plain interactive login shells on a PTY, forwarded verbatim
 * to xterm.js in the renderer. Nothing is interpreted here: the shell draws its
 * own prompt, full-screen programs get a real screen buffer, and keystrokes go
 * straight through. That makes a pane behave exactly like a window of the
 * user's own terminal.
 *
 * (Pipeline steps are different — they run through the scripted session in
 * `session.ts`, which reports exit codes.)
 */

/** OSC 7 — how a shell announces its working directory to its terminal. */
const OSC7 = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)(?:\x07|\x1b\\)/g

interface Session {
  proc: pty.IPty
  cwd: string
}

export class ShellManager {
  private sessions = new Map<string, Session>()
  /** Commands aimed at a pane whose PTY has not started yet. */
  private pending = new Map<string, string[]>()

  constructor(
    private onData: (e: ShellData) => void,
    private onExit: (e: ShellExit) => void,
    private onCwd: (e: ShellCwd) => void
  ) {}

  open(paneId: string, cwd: string, cols = 100, rows = 30): void {
    const existing = this.sessions.get(paneId)
    if (existing) return

    const shell = defaultShell()
    let proc: pty.IPty
    try {
      proc = pty.spawn(shell, process.platform === 'win32' ? [] : ['-il'], {
        name: 'xterm-256color',
        cols: Math.max(20, Math.min(500, Math.floor(cols))),
        rows: Math.max(5, Math.min(200, Math.floor(rows))),
        cwd,
        env: shellEnv()
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.onData({ tabId: paneId, chunk: `buildflow: cannot start ${shell}: ${message}\r\n` })
      return
    }

    const session: Session = { proc, cwd }
    this.sessions.set(paneId, session)

    // A login shell prints its prompt asynchronously; typing into it before
    // that lands gets eaten, so let it settle before flushing queued commands.
    const queued = this.pending.get(paneId)
    if (queued?.length) {
      this.pending.delete(paneId)
      setTimeout(() => {
        if (this.sessions.get(paneId) !== session) return
        for (const data of queued) session.proc.write(data)
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
      this.onExit({ tabId: paneId, code: exitCode, cwd: session.cwd, durationMs: 0, sessionEnded: true })
    })
  }

  /** Keystrokes and pasted text, straight to the PTY. */
  write(paneId: string, data: string): void {
    this.sessions.get(paneId)?.proc.write(data)
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
      return
    }
    const queue = this.pending.get(paneId) ?? []
    queue.push(data)
    this.pending.set(paneId, queue)
  }

  resize(paneId: string, cols: number, rows: number): void {
    const session = this.sessions.get(paneId)
    if (!session) return
    try {
      session.proc.resize(
        Math.max(20, Math.min(500, Math.floor(cols))),
        Math.max(5, Math.min(200, Math.floor(rows)))
      )
    } catch {
      /* the process may have just exited */
    }
  }

  dispose(paneId: string): void {
    this.pending.delete(paneId)
    const session = this.sessions.get(paneId)
    if (!session) return
    this.sessions.delete(paneId)
    try {
      session.proc.kill()
    } catch {
      /* already gone */
    }
  }

  disposeAll(): void {
    for (const paneId of [...this.sessions.keys()]) this.dispose(paneId)
  }
}
