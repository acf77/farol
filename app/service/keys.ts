import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import fs from 'fs'
import path from 'path'

/**
 * API keys for the run service. A key is `frl_<id>_<secret>`; only the id and a
 * SHA-256 of the secret are stored (the secret is 192 random bits, so a plain
 * hash is enough). The file is re-read on every check, so revoking a key takes
 * effect immediately without restarting the service.
 */

export interface ApiKeyRecord {
  id: string
  name: string
  hash: string
  createdAt: string
  revokedAt?: string
}

const KEY_RE = /^frl_([0-9a-f]{8})_([0-9a-f]{48})$/

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

function readKeys(file: string): ApiKeyRecord[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as ApiKeyRecord[]) : []
  } catch {
    return []
  }
}

function writeKeys(file: string, keys: ApiKeyRecord[]): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Issue a key. The plain key is returned once and never stored. */
export function createKey(file: string, name: string): { id: string; key: string } {
  const id = randomBytes(4).toString('hex')
  const secret = randomBytes(24).toString('hex')
  const record: ApiKeyRecord = { id, name, hash: sha256(secret), createdAt: new Date().toISOString() }
  writeKeys(file, [...readKeys(file), record])
  return { id, key: `frl_${id}_${secret}` }
}

export function listKeys(file: string): Omit<ApiKeyRecord, 'hash'>[] {
  return readKeys(file).map(({ id, name, createdAt, revokedAt }) => ({ id, name, createdAt, revokedAt }))
}

export function revokeKey(file: string, id: string): boolean {
  const keys = readKeys(file)
  const key = keys.find((k) => k.id === id && !k.revokedAt)
  if (!key) return false
  key.revokedAt = new Date().toISOString()
  writeKeys(file, keys)
  return true
}

/** The record a presented key belongs to, or null when it is malformed, unknown, or revoked. */
export function verifyKey(file: string, presented: string): ApiKeyRecord | null {
  const match = KEY_RE.exec(presented)
  if (!match) return null
  const record = readKeys(file).find((k) => k.id === match[1])
  if (!record || record.revokedAt) return null
  const expected = Buffer.from(record.hash, 'hex')
  const actual = Buffer.from(sha256(match[2]), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? record : null
}
