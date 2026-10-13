import { describe, expect, it } from 'vitest'
import { snapshotPaths, snapshotSummary, syncSummary } from './remote'

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

  it('leaves out audio, video, PDFs and design files', () => {
    expect(snapshotPaths('a.ts\0public/audio/song.MP3\0docs/spec.pdf\0clip.mov\0logo.svg\0')).toEqual(['a.ts', 'logo.svg'])
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

describe('syncSummary', () => {
  it('says how much travelled', () => {
    expect(syncSummary(10764, 0)).toBe('10764 files, nothing new to send')
    expect(syncSummary(1, 2048)).toBe('1 file, <0.1 MB sent')
    expect(syncSummary(3, 5 * 1024 * 1024)).toBe('3 files, 5.0 MB sent')
  })
})
