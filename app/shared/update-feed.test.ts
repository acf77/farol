import { describe, expect, it } from 'vitest'
import { parseUpdateFeed, versionAhead } from './update-feed'

describe('parseUpdateFeed', () => {
  it('reads version and zip path', () => {
    expect(
      parseUpdateFeed('version: 0.2.0\npath: Farol-0.2.0-arm64-mac.zip\n')
    ).toEqual({ version: '0.2.0', file: 'Farol-0.2.0-arm64-mac.zip' })
  })

  it('reads the top-level checksum of an electron-builder feed', () => {
    const yml = [
      'version: 0.2.0',
      'files:',
      '  - url: Farol-mac-arm64.zip',
      '    sha512: inner==',
      'path: Farol-mac-arm64.zip',
      'sha512: top==',
      "releaseDate: '2026-10-13T12:00:00.000Z'"
    ].join('\n')
    expect(parseUpdateFeed(yml)).toEqual({ version: '0.2.0', file: 'Farol-mac-arm64.zip', sha512: 'top==' })
  })

  it('rejects an empty file', () => {
    expect(parseUpdateFeed('')).toBeNull()
  })
})

describe('versionAhead', () => {
  it('compares major.minor.patch', () => {
    expect(versionAhead('0.2.0', '0.1.0')).toBe(true)
    expect(versionAhead('0.1.0', '0.2.0')).toBe(false)
    expect(versionAhead('0.1.0', '0.1.0')).toBe(false)
    expect(versionAhead('1.0.0', '0.9.9')).toBe(true)
  })
})
