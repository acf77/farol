import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcInfo, ProcSession } from '../shared/proc'
import { ProcCleanup } from './proc-cleanup'

const session: ProcSession = { id: 'a', worktree: '/w/a', cwdRoot: '/w/a', rootPid: 100, startedAt: 0, state: 'done' }
const empty = async () => ({ procs: [], approximate: false })

afterEach(() => vi.useRealTimers())

// The agent is gone; 101 is left in its process group, so a clean-up would signal it.
const leftover: ProcInfo = { pid: 101, ppid: 1, pgid: 100, uid: 1, startMs: 1000, footprint: 1, cpu: 0, name: 'node' }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

describe('ProcCleanup', () => {
  it('does nothing once stopped, even for a timer already set', () => {
    vi.useFakeTimers()
    const enabled = vi.fn().mockResolvedValue(true)
    const cleanup = new ProcCleanup({ sample: empty, sessions: () => [session], autoCleanEnabled: enabled, uid: 1, delayMs: 100 })
    cleanup.schedule(session)
    cleanup.stop()
    cleanup.schedule(session)
    vi.advanceTimersByTime(1000)
    cleanup.runAuto('a')
    expect(enabled).not.toHaveBeenCalled()
  })

  it('leaves processes alone when the setting is off', async () => {
    const sample = vi.fn(empty)
    const cleanup = new ProcCleanup({ sample, sessions: () => [session], autoCleanEnabled: async () => false, uid: 1 })
    cleanup.runAuto('a')
    await vi.waitFor(() => expect(sample).not.toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sample).not.toHaveBeenCalled()
  })

  it('returns an error, not an exception, when the process list cannot be read', async () => {
    const cleanup = new ProcCleanup({
      sample: async () => ({ procs: [], approximate: true, failed: true as const }),
      sessions: () => [session],
      autoCleanEnabled: async () => true,
      uid: 1
    })
    expect(await cleanup.kill('a')).toMatchObject({ ok: false, message: 'Could not read the process list.' })
  })

  it('sends no signal when stopped while the setting is still being read', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const setting = deferred<boolean>()
    const sample = vi.fn(async () => ({ procs: [leftover], approximate: false }))
    const cleanup = new ProcCleanup({ sample, sessions: () => [session], autoCleanEnabled: () => setting.promise, uid: 1 })
    cleanup.runAuto('a')
    cleanup.stop()
    setting.resolve(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sample).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    kill.mockRestore()
  })

  it('sends no signal when stopped while the first process list is still being read', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const listing = deferred<{ procs: ProcInfo[]; approximate: boolean }>()
    const cleanup = new ProcCleanup({ sample: () => listing.promise, sessions: () => [session], autoCleanEnabled: async () => true, uid: 1 })
    const result = cleanup.kill('a')
    cleanup.stop()
    listing.resolve({ procs: [leftover], approximate: false })
    expect(await result).toMatchObject({ ok: false, message: 'Farol is quitting.' })
    expect(kill).not.toHaveBeenCalled()
    kill.mockRestore()
  })
})
