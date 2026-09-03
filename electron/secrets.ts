import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'

export interface OpenRouterSecretStatus {
  configured: boolean
  source: 'environment' | 'stored' | 'none'
}

export interface SaveOpenRouterSecretResult extends OpenRouterSecretStatus {
  ok: boolean
  error?: string
}

const KEY_FILE = 'openrouter-key.bin'

function keyFile(): string {
  return path.join(app.getPath('userData'), KEY_FILE)
}

function environmentKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY?.trim() || undefined
}

function storedKey(): string | undefined {
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined
    const encrypted = fs.readFileSync(keyFile())
    return safeStorage.decryptString(encrypted).trim() || undefined
  } catch {
    return undefined
  }
}

export function openRouterSecretStatus(): OpenRouterSecretStatus {
  if (environmentKey()) return { configured: true, source: 'environment' }
  if (storedKey()) return { configured: true, source: 'stored' }
  return { configured: false, source: 'none' }
}

export function saveOpenRouterKey(raw: unknown): SaveOpenRouterSecretResult {
  if (typeof raw !== 'string') {
    return { ok: false, configured: false, source: 'none', error: 'API key must be text.' }
  }

  const key = raw.trim()
  if (!key) {
    try {
      fs.rmSync(keyFile(), { force: true })
    } catch {
      return { ok: false, ...openRouterSecretStatus(), error: 'Could not clear the saved key.' }
    }
    return { ok: true, ...openRouterSecretStatus() }
  }
  if (!key.startsWith('sk-or-')) {
    return {
      ok: false,
      ...openRouterSecretStatus(),
      error: 'OpenRouter keys start with sk-or-.'
    }
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      ...openRouterSecretStatus(),
      error: 'Secure credential storage is unavailable.'
    }
  }

  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(keyFile(), safeStorage.encryptString(key), { mode: 0o600 })
    fs.chmodSync(keyFile(), 0o600)
    return { ok: true, ...openRouterSecretStatus() }
  } catch {
    return { ok: false, ...openRouterSecretStatus(), error: 'Could not save the API key.' }
  }
}

/** Inject the credential only into processes explicitly routed through OpenRouter. */
export function openRouterEnv(): Record<string, string> {
  const key = environmentKey() ?? storedKey()
  if (!key) throw new Error('Add an OpenRouter API key in Farol settings before using OpenRouter.')
  return { OPENROUTER_API_KEY: key }
}
