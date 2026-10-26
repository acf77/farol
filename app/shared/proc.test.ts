import { describe, expect, it } from 'vitest'
import {
  attribute,
  formatBytes,
  leftoverSummary,
  procKey,
  memoryLevel,
  procLabel,
  snapshotOf,
  usageByRow,
  type ProcInfo,
  type ProcSession
} from './proc'

const UID = 501
const T = 1_700_000_000_000
const MB = 1024 * 1024

function proc(pid: number, ppid: number, over: Partial<ProcInfo> = {}): ProcInfo {
  return { pid, ppid, pgid: pid, uid: UID, startMs: T + 100, footprint: 10 * MB, cpu: 1, name: 'node', ...over }
}

function session(id: string, rootPid: number, worktree: string, over: Partial<ProcSession> = {}): ProcSession {
  return { id, worktree, cwdRoot: worktree, rootPid, startedAt: T, state: 'working', ...over }
}

const root = (pid: number, over: Partial<ProcInfo> = {}): ProcInfo => proc(pid, 1, { startMs: T, ...over })
const pids = (list: { pid: number }[]): number[] => list.map((p) => p.pid).sort((a, b) => a - b)

describe('attribute', () => {
  it('walks the process tree under the root', () => {
    const [usage] = attribute(
      [root(100), proc(101, 100), proc(102, 101), proc(200, 1)],
      [session('a', 100, '/w/a')],
      UID
    )
    expect(pids(usage.procs)).toEqual([100, 101, 102])
    expect(usage.procs.find((p) => p.pid === 102)?.via).toBe('tree')
    expect(usage.footprint).toBe(30 * MB)
  })

  it('finds an orphan by its working directory, and only inside the worktree', () => {
    const [usage] = attribute(
      [
        root(100),
        proc(300, 1, { cwd: '/w/a/web' }),
        proc(301, 1, { cwd: '/w/ab' }),
        proc(302, 1),
        proc(303, 50, { cwd: '/w/a' })
      ],
      [session('a', 100, '/w/a')],
      UID
    )
    expect(pids(usage.procs)).toEqual([100, 300])
    expect(usage.procs.find((p) => p.pid === 300)?.via).toBe('cwd')
    // A folder match alone is not proof that the agent started it.
    expect(usage.procs.find((p) => p.pid === 300)?.owned).toBe(false)
    expect(usage.procs.find((p) => p.pid === 100)?.owned).toBe(true)
  })

  it('trusts an orphan that was seen in the agent tree before launchd adopted it', () => {
    const orphan = proc(300, 1, { cwd: '/w/a' })
    const seen = new Set([procKey(orphan)])
    const [usage] = attribute([root(100), orphan], [session('a', 100, '/w/a', { seen })], UID)
    expect(usage.procs.find((p) => p.pid === 300)).toMatchObject({ via: 'cwd', owned: true })
  })

  it('gives every process one owner, and the tree beats the working directory', () => {
    const usages = attribute(
      [
        root(100),
        root(200, { startMs: T + 50 }),
        proc(101, 100, { cwd: '/w/b' }),
        proc(300, 1, { cwd: '/w/shared' })
      ],
      [
        session('a', 100, '/w/a'),
        session('b', 200, '/w/b', { startedAt: T + 50 }),
        session('s1', 900, '/w/shared', { startedAt: T - 5000 }),
        session('s2', 901, '/w/shared', { startedAt: T - 1000 })
      ],
      UID
    )
    const all = usages.flatMap((u) => u.procs.map((p) => p.pid))
    expect(new Set(all).size).toBe(all.length)
    expect(pids(usages.find((u) => u.sessionId === 'a')!.procs)).toEqual([100, 101])
    // The newest session that began before the process takes the orphan.
    expect(pids(usages.find((u) => u.sessionId === 's2')!.procs)).toEqual([300])
  })

  it('leaves alone an orphan that is older than the session', () => {
    const [usage] = attribute(
      [proc(300, 1, { cwd: '/w/a', startMs: T - 60_000 })],
      [session('a', 900, '/w/a')],
      UID
    )
    expect(usage.procs).toEqual([])
  })

  it('prefers the deepest worktree for an orphan', () => {
    const usages = attribute(
      [proc(300, 1, { cwd: '/w/a/packages/x/src' })],
      [session('outer', 900, '/w/a'), session('inner', 901, '/w/a/packages/x')],
      UID
    )
    expect(pids(usages.find((u) => u.sessionId === 'inner')!.procs)).toEqual([300])
    expect(usages.find((u) => u.sessionId === 'outer')!.procs).toEqual([])
  })

  it('catches pid reuse by start time', () => {
    const [usage] = attribute(
      [
        // The agent died and the pid went to a new process an hour later.
        proc(100, 1, { startMs: T + 3_600_000 }),
        proc(101, 100, { startMs: T + 3_600_100 }),
        // A group id from before the session is not this session's group.
        proc(102, 1, { pgid: 100, startMs: T - 3_600_000 })
      ],
      [session('a', 100, '/w/a')],
      UID
    )
    expect(usage.procs).toEqual([])
  })

  it('keeps the members of the root group after the root has died', () => {
    const [usage] = attribute(
      [proc(101, 1, { pgid: 100 }), proc(102, 101, { pgid: 100 })],
      [session('a', 100, '/w/a', { state: 'done' })],
      UID
    )
    expect(pids(usage.procs)).toEqual([101, 102])
    expect(usage.procs.every((p) => p.via === 'group')).toBe(true)
  })

  it('ignores processes of other users', () => {
    const [usage] = attribute([root(100), proc(101, 100, { uid: 0 })], [session('a', 100, '/w/a')], UID)
    expect(pids(usage.procs)).toEqual([100])
  })

  it('reports leftovers only for a finished session, never the agent itself', () => {
    const procs = [root(100), proc(101, 100)]
    const working = attribute(procs, [session('a', 100, '/w/a')], UID)[0]
    expect(working.leftovers).toEqual([])
    const done = attribute(procs, [session('a', 100, '/w/a', { state: 'done' })], UID)[0]
    expect(pids(done.leftovers)).toEqual([101])
    expect(done.leftoverFootprint).toBe(10 * MB)
  })
})

describe('summaries', () => {
  it('labels a runtime by its script', () => {
    expect(procLabel({ name: 'node', args: '/usr/bin/node /app/node_modules/.bin/vite --port 5173' })).toBe('vite')
    expect(procLabel({ name: 'node', args: 'node -e //x' })).toBe('node')
    expect(procLabel({ name: 'Google Chrome Helper' })).toBe('Google Chrome Helper')
  })

  it('writes the badge tooltip', () => {
    const [usage] = attribute(
      [
        proc(101, 1, { pgid: 100, args: 'node /x/node_modules/.bin/vite', footprint: 800 * MB }),
        proc(102, 1, { pgid: 100, name: 'chromium', footprint: 500 * MB }),
        proc(103, 1, { pgid: 100, name: 'chromium', footprint: 500 * MB })
      ],
      [session('a', 100, '/w/a', { state: 'done' })],
      UID
    )
    expect(leftoverSummary(usage.leftovers)).toBe('2 chromium + vite still running (1.8 GB)')
  })

  it('formats sizes and colors by threshold', () => {
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB')
    expect(formatBytes(300 * MB)).toBe('300 MB')
    expect(memoryLevel(1 * 1024 ** 3, 2, 4)).toBe('ok')
    expect(memoryLevel(2 * 1024 ** 3, 2, 4)).toBe('warn')
    expect(memoryLevel(5 * 1024 ** 3, 2, 4)).toBe('alert')
  })

  it('folds sessions into the row that contains their worktree', () => {
    const usages = attribute(
      [root(100), root(200, { startMs: T + 1 })],
      [session('a', 100, '/w/a/sub'), session('b', 200, '/w/b', { startedAt: T + 1 })],
      UID
    )
    const snapshot = snapshotOf(usages, T, false)
    const rows = usageByRow(snapshot, ['/w/a', '/w/b', '/w/c'])
    expect(rows.get('/w/a')?.footprint).toBe(10 * MB)
    expect(rows.get('/w/b')?.footprint).toBe(10 * MB)
    expect(rows.has('/w/c')).toBe(false)
    expect(snapshot.totalFootprint).toBe(20 * MB)
  })
})
