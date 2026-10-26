import { realpathSync } from 'fs'
import { procKey, type ProcSession, type SessionUsage } from '../shared/proc'

/**
 * The agent sessions Farol has started, kept after their process exits so the
 * processes they left behind can still be found. One entry per agent run.
 */
export class ProcRegistry {
  private sessions = new Map<string, ProcSession>()

  constructor(private onDone?: (session: ProcSession) => void) {}

  /** An agent CLI just started; it leads its own process group. */
  register(id: string, worktree: string, rootPid: number): void {
    if (!Number.isInteger(rootPid) || rootPid <= 0) return
    let cwdRoot = worktree
    try {
      cwdRoot = realpathSync(worktree)
    } catch {
      /* the path may be gone; match it as given */
    }
    this.sessions.set(id, { id, worktree, cwdRoot, rootPid, startedAt: Date.now(), state: 'working' })
  }

  /** Remember what was seen in each agent's tree or group, so a later orphan can be tied back to it. */
  noteSeen(usages: SessionUsage[]): void {
    for (const usage of usages) {
      const session = this.sessions.get(usage.sessionId)
      if (!session) continue
      const seen = session.seen ?? (session.seen = new Set())
      for (const p of usage.procs) if (p.via !== 'cwd') seen.add(procKey(p))
    }
  }

  finish(id: string): void {
    const session = this.sessions.get(id)
    if (!session || session.state === 'done') return
    session.state = 'done'
    this.onDone?.(session)
  }

  remove(id: string): void {
    this.sessions.delete(id)
  }

  list(): ProcSession[] {
    return [...this.sessions.values()]
  }
}
