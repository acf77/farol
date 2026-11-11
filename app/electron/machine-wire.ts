/** Encoding Remote machine frames as JSON lines. Node-only (binary goes through `Buffer`). */
import type { MachineFrame } from '../shared/machine'

const BYTES_KEY = '__farolBytes'

/** JSON with binary (ArrayBuffer, typed arrays, Buffer) carried as base64. */
export function encodeFrame(frame: MachineFrame): string {
  return JSON.stringify(frame, function (this: unknown, key, value: unknown) {
    // `Buffer#toJSON` runs before the replacer sees it, so read the raw holder value.
    const raw = (this as Record<string, unknown>)[key]
    if (raw instanceof ArrayBuffer) return { [BYTES_KEY]: Buffer.from(raw).toString('base64') }
    if (ArrayBuffer.isView(raw)) {
      return { [BYTES_KEY]: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64') }
    }
    return value
  })
}

/** Inverse of `encodeFrame`; binary comes back as an `ArrayBuffer`. Null on a line that is not a frame. */
export function decodeFrame(line: string): MachineFrame | null {
  try {
    const frame = JSON.parse(line, (_key, value: unknown) => {
      if (value && typeof value === 'object' && typeof (value as Record<string, unknown>)[BYTES_KEY] === 'string') {
        const buf = Buffer.from((value as Record<string, string>)[BYTES_KEY], 'base64')
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      }
      return value
    }) as unknown
    return frame && typeof frame === 'object' && typeof (frame as { t?: unknown }).t === 'string'
      ? (frame as MachineFrame)
      : null
  } catch {
    return null
  }
}

/** Splits a stream into complete lines; `rest` is the unfinished tail. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.filter((l) => l.trim()), rest }
}
