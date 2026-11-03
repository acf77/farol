import { attribute, sameStart, type AttributedProc, type ProcInfo, type ProcSession } from '../shared/proc'

export const KILL_GRACE_MS = 3000

export interface KillDeps {
  /** A fresh process listing. */
  sample(): Promise<ProcInfo[]>
  sessions(): ProcSession[]
  /** One pid only: never a group, so nothing outside the session can be hit. */
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
  sleep(ms: number): Promise<void>
  uid: number
}

export interface KillResult {
  ok: boolean
  message?: string
  terminated: number
  killed: number
}

const refused = (message: string): KillResult => ({ ok: false, message, terminated: 0, killed: 0 })

function stillRunning(sample: ProcInfo[], target: AttributedProc): boolean {
  return sample.some((p) => p.pid === target.pid && sameStart(p.startMs, target.startMs))
}

async function terminate(targets: AttributedProc[], deps: KillDeps, graceMs: number): Promise<KillResult> {
  for (const target of targets) deps.signal(target.pid, 'SIGTERM')
  await deps.sleep(graceMs)
  // The same pid with a new start time is someone else's process now.
  const after = await deps.sample()
  const survivors = targets.filter((target) => stillRunning(after, target))
  for (const target of survivors) deps.signal(target.pid, 'SIGKILL')
  return { ok: true, terminated: targets.length - survivors.length, killed: survivors.length }
}

/**
 * Stop what a session left behind, or one process of it. The target list comes
 * from a fresh attribution, so a pid that is not this session's, or whose start
 * time changed, is never signalled. The agent itself is protected while the
 * session works. Cleaning all leftovers takes only processes proven to be the
 * agent's; one found by working directory alone needs a request for that pid.
 */
export async function killSessionProcs(
  sessionId: string,
  pid: number | undefined,
  deps: KillDeps,
  graceMs = KILL_GRACE_MS
): Promise<KillResult> {
  const sessions = deps.sessions()
  const usage = attribute(await deps.sample(), sessions, deps.uid).find((u) => u.sessionId === sessionId)
  const session = sessions.find((s) => s.id === sessionId)
  if (!usage || !session) return refused('This session is gone.')

  if (pid === undefined) {
    if (session.state === 'working') return refused('The agent is still working.')
    const proven = usage.leftovers.filter((p) => p.owned)
    if (!proven.length) return { ok: true, terminated: 0, killed: 0 }
    return terminate(proven, deps, graceMs)
  }

  const target = usage.procs.find((p) => p.pid === pid)
  if (!target) return refused('That process does not belong to this session.')
  if (target.isRoot && session.state === 'working') return refused('The agent is still working.')
  return terminate([target], deps, graceMs)
}
