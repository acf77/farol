import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'

interface SecretsFile {
  openrouterApiKey?: string
}

let cachedKey: string | null | undefined

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
  if (!next.openrouterApiKey) {
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

export function hasOpenRouterKey(): boolean {
  return peekOpenRouterKey() !== null
}

export function peekOpenRouterKey(): string | null {
  if (cachedKey !== undefined) return cachedKey
  const stored = readFile().openrouterApiKey
  cachedKey = stored ? decrypt(stored) : null
  return cachedKey
}

export function setOpenRouterKey(plain: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Cannot encrypt the API key on this machine.')
  }
  const key = plain.trim()
  if (!key) {
    clearOpenRouterKey()
    return
  }
  writeFile({ openrouterApiKey: safeStorage.encryptString(key).toString('base64') })
  cachedKey = key
}

export function clearOpenRouterKey(): void {
  writeFile({})
  cachedKey = null
}
