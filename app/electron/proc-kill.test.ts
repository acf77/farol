import { describe, expect, it } from 'vitest'
import { procKey, type ProcInfo, type ProcSession } from '../shared/proc'
import { killSessionProcs, type KillDeps } from './proc-kill'

const UID = 501
const T = 1_700_000_000_000

function proc(pid: number, ppid: number, over: Partial<ProcInfo> = {}): ProcInfo {
  return { pid, ppid, pgid: pid, uid: UID, startMs: T + 100, footprint: 1, cpu: 0, name: 'node', ...over }
}

/** A tiny machine: signals change the process table the next sample sees. */
function machine(
  procs: ProcInfo[],
  sessions: ProcSession[],
  onSignal: (pid: number, signal: 'SIGTERM' | 'SIGKILL', table: ProcInfo[]) => ProcInfo[]
) {
  let table = procs
  const signals: [number, string][] = []
  const deps: KillDeps = {
    sample: async () => table,
    sessions: () => sessions,
    signal: (pid, signal) => {
      signals.push([pid, signal])
      table = onSignal(pid, signal, table)
    },
    sleep: async () => undefined,
    uid: UID
  }
  return { deps, signals, table: () => table }
}

const without = (table: ProcInfo[], pid: number): ProcInfo[] => table.filter((p) => p.pid !== pid)
const exitOnAnySignal = (pid: number, _signal: string, table: ProcInfo[]): ProcInfo[] => without(table, pid)

const doneSession: ProcSession = {
  id: 'a',
  worktree: '/w/a',
  cwdRoot: '/w/a',
  rootPid: 100,
  startedAt: T,
  state: 'done'
}
const workingSession: ProcSession = { ...doneSession, state: 'working' }

// The agent (100) is gone; its group left 101 and 102, and 300 is an orphan in the worktree.
const leftovers = (): ProcInfo[] => [
  proc(101, 1, { pgid: 100 }),
  proc(102, 101, { pgid: 100 }),
  proc(300, 1, { cwd: '/w/a/web' }),
  proc(900, 1, { cwd: '/elsewhere' }),
  proc(901, 50, { uid: 0 })
]

describe('killSessionProcs', () => {
  it('sends SIGTERM, waits, then SIGKILL to what survived', async () => {
    const m = machine(leftovers(), [doneSession], (pid, signal, table) =>
      // 101 ignores SIGTERM; the others exit on it.
      pid === 101 && signal === 'SIGTERM' ? table : without(table, pid)
    )
    const result = await killSessionProcs('a', undefined, m.deps)
    // 300 matches by folder only, so cleaning all leftovers leaves it alone.
    expect(m.signals.filter(([, s]) => s === 'SIGTERM').map(([pid]) => pid).sort()).toEqual([101, 102])
    expect(m.signals.filter(([, s]) => s === 'SIGKILL')).toEqual([[101, 'SIGKILL']])
    expect(result).toMatchObject({ ok: true, terminated: 1, killed: 1 })
  })

  it('stops a folder-only match when asked for that pid, or once it was seen in the agent group', async () => {
    const explicit = machine(leftovers(), [doneSession], exitOnAnySignal)
    await killSessionProcs('a', 300, explicit.deps)
    expect(explicit.signals).toEqual([[300, 'SIGTERM']])

    const seen = { ...doneSession, seen: new Set([procKey(proc(300, 1))]) }
    const proven = machine(leftovers(), [seen], exitOnAnySignal)
    await killSessionProcs('a', undefined, proven.deps)
    expect(proven.signals.map(([pid]) => pid).sort()).toEqual([101, 102, 300])
  })

  it('never signals a process outside the session', async () => {
    const m = machine(leftovers(), [doneSession], exitOnAnySignal)
    await killSessionProcs('a', undefined, m.deps)
    const touched = m.signals.map(([pid]) => pid)
    expect(touched).not.toContain(900)
    expect(touched).not.toContain(901)
    expect(touched).not.toContain(300)
    expect(m.table().map((p) => p.pid).sort()).toEqual([300, 900, 901])
  })

  it('refuses to clean a session that is still working', async () => {
    const m = machine(leftovers(), [workingSession], exitOnAnySignal)
    const result = await killSessionProcs('a', undefined, m.deps)
    expect(result.ok).toBe(false)
    expect(m.signals).toEqual([])
  })

  it('protects the agent while it works, but lets a single child go', async () => {
    const table = [proc(100, 1, { startMs: T }), proc(101, 100)]
    const m = machine(table, [workingSession], exitOnAnySignal)
    const agent = await killSessionProcs('a', 100, m.deps)
    expect(agent.ok).toBe(false)
    expect(m.signals).toEqual([])
    const child = await killSessionProcs('a', 101, m.deps)
    expect(child).toMatchObject({ ok: true, terminated: 1 })
    expect(m.signals.map(([pid]) => pid)).toEqual([101])
  })

  it('never lists the agent among leftovers of a done session', async () => {
    const table = [proc(100, 1, { startMs: T }), proc(101, 100)]
    const m = machine(table, [doneSession], exitOnAnySignal)
    await killSessionProcs('a', undefined, m.deps)
    expect(m.signals.map(([pid]) => pid)).toEqual([101])
  })

  it('refuses a pid that belongs to no session', async () => {
    const m = machine(leftovers(), [doneSession], exitOnAnySignal)
    const result = await killSessionProcs('a', 900, m.deps)
    expect(result.ok).toBe(false)
    expect(m.signals).toEqual([])
  })

  it('does not SIGKILL a pid that was reused after the SIGTERM', async () => {
    const m = machine([proc(101, 1, { pgid: 100 })], [doneSession], (pid, signal, table) =>
      // 101 exits on SIGTERM and an unrelated process takes the pid at once.
      signal === 'SIGTERM' ? [...without(table, pid), proc(pid, 7, { startMs: T + 60_000 })] : table
    )
    const result = await killSessionProcs('a', undefined, m.deps)
    expect(m.signals).toEqual([[101, 'SIGTERM']])
    expect(result).toMatchObject({ ok: true, terminated: 1, killed: 0 })
  })

  it('stops when the process list cannot be read, instead of trusting an empty one', async () => {
    const m = machine(leftovers(), [doneSession], exitOnAnySignal)
    let reads = 0
    const flaky: KillDeps = {
      ...m.deps,
      // The first read works; the read after SIGTERM fails.
      sample: async () => {
        if (reads++) throw new Error('ps failed')
        return leftovers()
      }
    }
    await expect(killSessionProcs('a', undefined, flaky)).rejects.toThrow('ps failed')
    expect(m.signals.some(([, s]) => s === 'SIGKILL')).toBe(false)
  })

  it('reports a session that is gone', async () => {
    const m = machine([], [], exitOnAnySignal)
    expect((await killSessionProcs('nope', undefined, m.deps)).ok).toBe(false)
  })
})
