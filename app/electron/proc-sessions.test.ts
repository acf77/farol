import { describe, expect, it } from 'vitest'
import { attribute, procKey, type ProcInfo } from '../shared/proc'
import { ProcRegistry } from './proc-sessions'

describe('ProcRegistry process identity', () => {
  it('remembers precise processes but refuses reused and coarse identities', () => {
    const registry = new ProcRegistry()
    registry.register('a', process.cwd(), 100)
    const startedAt = registry.list()[0].startedAt
    const root: ProcInfo = {
      pid: 100, ppid: 1, pgid: 100, uid: 501, startMs: startedAt,
      startId: '1700000000:0', footprint: 1, cpu: 0, name: 'claude'
    }
    const child = { ...root, pid: 101, ppid: 100, startMs: startedAt + 100, startId: '1700000000:100000' }
    const coarse = { ...child, pid: 102, startId: undefined }
    registry.noteSeen(attribute([root, child, coarse], registry.list(), 501))
    expect(registry.list()[0].seen).toEqual(new Set([procKey(root), procKey(child)]))
    registry.finish('a')

    const orphan = { ...child, ppid: 1, pgid: 101 }
    expect(attribute([orphan], registry.list(), 501)[0].procs[0]).toMatchObject({ owned: true, via: 'seen' })
    for (const startId of ['1700000000:100001', '1700000000:800000', undefined]) {
      const reused = { ...orphan, startMs: startedAt + 800, startId }
      expect(attribute([reused], registry.list(), 501)[0].procs).toEqual([])
    }
  })
})
