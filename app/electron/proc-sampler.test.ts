import { describe, expect, it } from 'vitest'
import { parsePs } from './proc-sampler'

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
    expect(chrome).toMatchObject({ pid: 102, ppid: 101, name: 'Google Chrome' })
    expect(Number.isNaN(chrome.startMs)).toBe(false)
  })
})
