import * as childProcess from 'child_process'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { describe, expect, it, vi } from 'vitest'
import { procKey } from '../shared/proc'
import { parsePs, ProcSampler } from './proc-sampler'
import { ProcRegistry } from './proc-sessions'

describe('parsePs', () => {
  it('reads the fallback listing: RSS in KiB, start time, command basename', () => {
    const out = [
      '  101     1   101   501  20480   3.5 Mon Oct 26 10:00:00 2026 /usr/local/bin/node',
      '  102   101   101   501    512   0.0 Mon Oct  5 09:05:07 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      'garbage line'
    ].join('\n')
    const [node, chrome, ...rest] = parsePs(out)
    expect(rest).toEqual([])
    expect(node).toMatchObject({ pid: 101, ppid: 1, pgid: 101, uid: 501, footprint: 20480 * 1024, cpu: 3.5, name: 'node' })
    expect(node.startMs).toBe(Date.parse('Mon Oct 26 10:00:00 2026'))
    expect(procKey(node)).toBeUndefined()
    expect(chrome).toMatchObject({ pid: 102, ppid: 101, name: 'Google Chrome' })
    expect(Number.isNaN(chrome.startMs)).toBe(false)
  })
})

describe('native process identity', () => {
  it.skipIf(process.platform !== 'darwin')('preserves microseconds from the helper', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const helper = Object.assign(new EventEmitter(), { stdin, stdout, kill: vi.fn() })
    const spawn = vi.spyOn(childProcess, 'spawn').mockReturnValue(helper as unknown as childProcess.ChildProcess)
    let usec = 123456
    stdin.on('data', () => queueMicrotask(() => stdout.write(JSON.stringify({ p: [{
      pid: 101, ppid: 1, pgid: 101, uid: 501, sec: 1700000000, usec: usec++, fp: 1, cpu: 0, name: 'node'
    }] }) + '\n')))
    const sampler = new ProcSampler({
      registry: new ProcRegistry(), helperPath: '/mock/procsnap', uid: 501,
      isVisible: () => true, onSnapshot: () => undefined
    })
    try {
      const first = (await sampler.sample()).procs[0]
      const second = (await sampler.sample()).procs[0]
      expect(first.startMs).toBe(1700000000 * 1000 + 123456 / 1000)
      expect(first.startId).toBe('1700000000:123456')
      expect(second.startId).toBe('1700000000:123457')
      expect(procKey(first)).not.toBe(procKey(second))
    } finally {
      sampler.stop()
      spawn.mockRestore()
      stdin.destroy()
      stdout.destroy()
    }
  })
})
