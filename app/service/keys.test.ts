import fs from 'fs'
import os from 'os'
import path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createKey, listKeys, revokeKey, verifyKey } from './keys'

let file: string

beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'farol-keys-')), 'keys.json')
})

describe('API keys', () => {
  it('verifies an issued key and stores only a hash of it', () => {
    const { id, key } = createKey(file, 'web app')
    expect(verifyKey(file, key)?.id).toBe(id)
    expect(fs.readFileSync(file, 'utf8')).not.toContain(key.split('_')[2])
  })

  it('rejects wrong secrets and malformed keys', () => {
    const { id } = createKey(file, 'web app')
    expect(verifyKey(file, `frl_${id}_${'0'.repeat(48)}`)).toBeNull()
    expect(verifyKey(file, 'nope')).toBeNull()
    expect(verifyKey(file, '')).toBeNull()
  })

  it('stops accepting a key as soon as it is revoked', () => {
    const { id, key } = createKey(file, 'phone')
    expect(revokeKey(file, id)).toBe(true)
    expect(verifyKey(file, key)).toBeNull()
    expect(revokeKey(file, id)).toBe(false)
    expect(listKeys(file)).toEqual([expect.objectContaining({ id, name: 'phone', revokedAt: expect.any(String) })])
  })
})
