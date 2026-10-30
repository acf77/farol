import type { ProcSession } from '../shared/proc'
import { killSessionProcs, type KillDeps, type KillResult } from './proc-kill'
import type { Sample } from './proc-sampler'

/** After a session is done, how long its processes may keep running before auto clean-up looks at them. */
export const AUTO_CLEAN_DELAY_MS = 10_000

/** A failure whose message is safe to show the user. */
class PublicError extends Error {}

export interface CleanupOptions {
  sample: () => Promise<Sample>
  sessions: () => ProcSession[]
  /** The "clean up automatically" setting, read when a clean-up is due. */
  autoCleanEnabled: () => Promise<boolean>
  uid: number
  delayMs?: number
}

/**
 * Stops what agent sessions leave behind: on request, and (when the setting is
 * on) a while after a session is done or its worktree is gone. `stop()` ends
 * it for good: timers are cleared, nothing new starts, and a wait for a process
 * to exit ends without sending SIGKILL.
 */
export class ProcCleanup {
  private shutdown = new AbortController()
  private timers = new Set<NodeJS.Timeout>()
  private running = new Set<string>()
  private deps: KillDeps

  constructor(private opts: CleanupOptions) {
    this.deps = {
      sample: async () => {
        const { procs, failed } = await opts.sample()
        this.assertRunning()
        // An empty list from a failed read must not look like "everything exited".
        if (failed) throw new PublicError('Could not read the process list.')
        return procs
      },
      sessions: opts.sessions,
      signal: (pid, signal) => {
        // Checked at the point of signalling, so work that was already waiting cannot act after stop().
        this.assertRunning()
        try {
          process.kill(pid, signal)
        } catch {
          /* already gone */
        }
      },
      sleep: (ms) => this.sleep(ms),
      uid: opts.uid
    }
  }

  private assertRunning(): void {
    if (this.shutdown.signal.aborted) throw new PublicError('Farol is quitting.')
  }

  private sleep(ms: number): Promise<void> {
    const { signal } = this.shutdown
    return new Promise((resolve, reject) => {
      const stop = (): void => {
        clearTimeout(timer)
        reject(new PublicError('Farol is quitting.'))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', stop)
        resolve()
      }, ms)
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop, { once: true })
    })
  }

  /** A session is done: look at its leftovers after a delay. */
  schedule(session: ProcSession): void {
    if (this.shutdown.signal.aborted) return
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.runAuto(session.id)
    }, this.opts.delayMs ?? AUTO_CLEAN_DELAY_MS)
    this.timers.add(timer)
  }

  /** Clean one session now if the setting is on, once at a time. */
  runAuto(sessionId: string): void {
    if (this.shutdown.signal.aborted || this.running.has(sessionId)) return
    this.running.add(sessionId)
    void this.opts
      .autoCleanEnabled()
      .then((on) => (on && !this.shutdown.signal.aborted ? killSessionProcs(sessionId, undefined, this.deps) : undefined))
      .catch(() => undefined)
      .finally(() => this.running.delete(sessionId))
  }

  /** A user request: all proven leftovers of a session, or one pid. */
  async kill(sessionId: string, pid?: number): Promise<KillResult> {
    try {
      return await killSessionProcs(sessionId, pid, this.deps)
    } catch (error) {
      // Only errors written for the user reach the renderer; anything else is logged here.
      if (!(error instanceof PublicError)) console.error('farol: process clean-up failed', error)
      const message = error instanceof PublicError ? error.message : 'Could not stop it.'
      return { ok: false, message, terminated: 0, killed: 0 }
    }
  }

  stop(): void {
    this.shutdown.abort()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
}
