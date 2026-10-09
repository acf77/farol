import { describe, expect, it, vi } from 'vitest'
import type { RemoteWorkspace } from '../shared/remote'
import { BusyError, RunRegistry } from './runs'

const pipeline = { id: 'ci', name: 'CI', nodes: [{ id: 'a', name: 'a', type: 'shell', cmd: 'sleep', after: [], x: 0, y: 0 }] } as never

/** A sandbox whose command never finishes on its own; closing it ends the command. */
function hangingWorkspace(): RemoteWorkspace {
  let finish: (code: number) => void = () => undefined
  return {
    summary: '',
    exec: () => new Promise<number>((resolve) => (finish = resolve)),
    close: vi.fn(async () => finish(130))
  }
}

describe('run registry limits', () => {
  it('caps how many sandboxes one owner holds', () => {
    const registry = new RunRegistry(async () => hangingWorkspace(), { maxActive: 10, maxPerOwner: 1, retentionMs: 1000 }, () => undefined)
    registry.start('user:1', pipeline, Buffer.alloc(0))
    expect(() => registry.start('user:1', pipeline, Buffer.alloc(0))).toThrow(BusyError)
    expect(() => registry.start('user:2', pipeline, Buffer.alloc(0))).not.toThrow()
    registry.cancelAll()
  })

  it('stops a run that outlives its time limit and fails it', async () => {
    const sandbox = hangingWorkspace()
    const open = async (_archive: Buffer, signal: AbortSignal) => {
      signal.addEventListener('abort', () => void sandbox.close())
      return sandbox
    }
    const registry = new RunRegistry(open, { maxActive: 1, retentionMs: 1000, maxDurationMs: 50 }, () => undefined)
    const record = registry.start('user:1', pipeline, Buffer.alloc(0))
    await vi.waitFor(() => expect(record.result.finishedAt).toBeDefined(), { timeout: 2000 })
    expect(record.result).toMatchObject({ status: 'failed', error: 'Run stopped after the 0-minute limit' })
    expect(record.events.map((e) => e.event)).toContainEqual({ type: 'error', message: 'Run stopped after the 0-minute limit' })
    expect(sandbox.close).toHaveBeenCalled()
  })
})
