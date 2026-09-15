import * as pty from 'node-pty'
import { interactiveAiCommand, isAiProvider, type AiProvider } from '../shared/ai'
import type { ShellCwd, ShellData, ShellExit } from '../shared/types'
import { aiEnv, resolveBin } from './bin'
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
const OSC7 = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)(?:\x07|\x1b\\)/g

function terminalSize(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Math.max(20, Math.min(500, Math.floor(cols))),
    rows: Math.max(5, Math.min(200, Math.floor(rows)))
  }
}

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

  open(paneId: string, cwd: string, cols = 100, rows = 30, provider?: AiProvider): void {
    const existing = this.sessions.get(paneId)
    if (existing) return

    const agent = isAiProvider(provider) ? provider : undefined
    const command = agent ? interactiveAiCommand(agent) : defaultShell()
    const args = agent || process.platform === 'win32' ? [] : ['-il']
    let proc: pty.IPty
    try {
      proc = pty.spawn(agent ? (resolveBin(command) ?? command) : command, args, {
        name: 'xterm-256color',
        ...terminalSize(cols, rows),
        cwd,
        env: agent ? aiEnv(agent) : shellEnv()
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.onData({ tabId: paneId, chunk: `farol: cannot start ${command}: ${message}\r\n` })
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
