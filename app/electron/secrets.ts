import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import type { ProviderKey } from '../shared/ai'

/** One entry per provider Farol holds a key for, each encrypted at rest. */
export type SecretName = 'openrouterApiKey' | 'aiGatewayApiKey' | 'remoteSession' | `${ProviderKey}ApiKey`

type SecretsFile = Partial<Record<SecretName, string>>

const cache = new Map<SecretName, string | null>()

function secretsPath(): string {
  return path.join(app.getPath('userData'), 'secrets.json')
}

function readFile(): SecretsFile {
  try {
    const raw = JSON.parse(fs.readFileSync(secretsPath(), 'utf8')) as unknown
    return raw && typeof raw === 'object' ? (raw as SecretsFile) : {}
  } catch {
    return {}
  }
}

function writeFile(next: SecretsFile): void {
  const file = secretsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!Object.values(next).some(Boolean)) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* gone */
    }
    return
  }
  fs.writeFileSync(file, JSON.stringify(next) + '\n', 'utf8')
}

function decrypt(payload: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(payload, 'base64'))
  } catch {
    return null
  }
}

export function hasSecret(name: SecretName): boolean {
  return peekSecret(name) !== null
}

export function peekSecret(name: SecretName): string | null {
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  const stored = readFile()[name]
  const value = stored ? decrypt(stored) : null
  cache.set(name, value)
  return value
}

export function setSecret(name: SecretName, plain: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Cannot encrypt the API key on this machine.')
  }
  const key = plain.trim()
  if (!key) {
    clearSecret(name)
    return
  }
  writeFile({ ...readFile(), [name]: safeStorage.encryptString(key).toString('base64') })
  cache.set(name, key)
}

export function clearSecret(name: SecretName): void {
  const next = readFile()
  delete next[name]
  writeFile(next)
  cache.set(name, null)
}
