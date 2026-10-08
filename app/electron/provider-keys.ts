import { isProviderKey } from '../shared/ai'
import type { SettingsResult } from '../shared/types'
import { clearSecret, setSecret } from './secrets'
import { loadSettings } from './store'
import { errorMessage } from '../shared/jev'

async function result(error?: string): Promise<SettingsResult> {
  return { settings: await loadSettings(), ...(error ? { error } : {}) }
}

export async function saveProviderKey(name: unknown, raw: unknown): Promise<SettingsResult> {
  if (!isProviderKey(name)) return result('Unknown provider.')
  if (typeof raw !== 'string' || !raw.trim()) return result('Paste an API key.')
  try {
    setSecret(`${name}ApiKey`, raw)
  } catch (err) {
    return result(errorMessage(err))
  }
  return result()
}

export async function clearProviderKey(name: unknown): Promise<SettingsResult> {
  if (isProviderKey(name)) clearSecret(`${name}ApiKey`)
  return result()
}
