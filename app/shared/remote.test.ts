import { describe, expect, it } from 'vitest'
import { snapshotPaths, snapshotSummary } from './remote'

describe('snapshotPaths', () => {
  it('keeps tracked and untracked paths once', () => {
    expect(snapshotPaths('a.ts\0src/b.ts\0a.ts\0')).toEqual(['a.ts', 'src/b.ts'])
  })

  it('withholds secret-looking files', () => {
    expect(snapshotPaths('.env\0.env.local\0.env.example\0keys/id_rsa\0x.pem\0ok.ts\0')).toEqual([
      '.env.example',
      'ok.ts'
    ])
  })

  it('returns nothing for empty output', () => {
    expect(snapshotPaths('')).toEqual([])
  })
})

describe('snapshotSummary', () => {
  it('pluralises and rounds', () => {
    expect(snapshotSummary(1, 10)).toBe('1 file, <0.1 MB')
    expect(snapshotSummary(3, 5 * 1024 * 1024)).toBe('3 files, 5.0 MB')
    expect(snapshotSummary(0, 512 * 1024)).toBe('<0.1 MB')
  })
})
