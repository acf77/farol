import { describe, expect, it } from 'vitest'
import { decodeFrame, encodeFrame, splitLines } from './machine-wire'

describe('machine wire', () => {
  it('round-trips calls, binary included', () => {
    const bytes = new Uint8Array([0, 1, 254, 255])
    const line = encodeFrame({ t: 'call', id: 7, ch: 'project:saveAttachment', args: ['/p', 'a.png', bytes.buffer] })
    expect(line).not.toContain('\n')
    const frame = decodeFrame(line)
    expect(frame?.t).toBe('call')
    const args = (frame as { args: unknown[] }).args
    expect(args.slice(0, 2)).toEqual(['/p', 'a.png'])
    expect(new Uint8Array(args[2] as ArrayBuffer)).toEqual(bytes)
  })

  it('carries a Buffer and a typed-array view as their own bytes', () => {
    const buf = Buffer.from('hello')
    const view = new Uint8Array([9, 8, 7, 6]).subarray(1, 3)
    const frame = decodeFrame(encodeFrame({ t: 'ev', ch: 'x', payload: { buf, view } })) as { payload: Record<string, ArrayBuffer> }
    expect(Buffer.from(frame.payload.buf).toString()).toBe('hello')
    expect([...new Uint8Array(frame.payload.view)]).toEqual([8, 7])
  })

  it('ignores lines that are not frames', () => {
    expect(decodeFrame('Last login: Tue')).toBeNull()
    expect(decodeFrame('{"no":"type"}')).toBeNull()
  })

  it('splits a stream into whole lines', () => {
    expect(splitLines('a\nb\n\nc')).toEqual({ lines: ['a', 'b'], rest: 'c' })
  })
})
