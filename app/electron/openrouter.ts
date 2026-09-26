import type { AiModel, AppSettings, SettingsResult } from '../shared/types'
import {
  OPENROUTER_MODELS_URL,
  parseOpenRouterCatalog,
  recommendedPins,
  uniqueIds
} from '../shared/openrouter'
import { defaultOpenRouter, withOpenRouterKeyFlag } from '../shared/settings'
import { clearSecret, hasSecret, peekSecret, setSecret } from './secrets'
import { loadSettings, saveSettings } from './store'
import { clearUsageCache } from './usage'

async function currentSettings(): Promise<AppSettings> {
  return withOpenRouterKeyFlag(await loadSettings(), hasSecret('openrouterApiKey'))
}

async function writeOpenRouter(
  patch: Partial<{ pinned: string[]; catalog: AiModel[]; autoPinned: boolean }>,
  agentReset?: boolean
): Promise<AppSettings> {
  const settings = await loadSettings()
  const prev = settings.openrouter ?? defaultOpenRouter()
  const next: AppSettings = {
    ...settings,
    ...(agentReset ? { agent: 'claude' as const } : {}),
    openrouter: {
      pinned: patch.pinned ?? prev.pinned,
      catalog: patch.catalog ?? prev.catalog,
      autoPinned: patch.autoPinned ?? prev.autoPinned,
      ...(prev.agent ? { agent: prev.agent } : {})
    }
  }
  await saveSettings(next)
  return withOpenRouterKeyFlag(next, hasSecret('openrouterApiKey'))
}

export async function fetchOpenRouterCatalog(apiKey: string): Promise<AiModel[]> {
  const res = await fetch(OPENROUTER_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? 'OpenRouter rejected this API key.'
        : `OpenRouter catalog failed (${res.status}).`
    )
  }
  return parseOpenRouterCatalog(await res.json())
}

async function applyCatalog(catalog: AiModel[]): Promise<AppSettings> {
  const settings = await loadSettings()
  const prev = settings.openrouter ?? defaultOpenRouter()
  const autoPin = !prev.autoPinned && catalog.length > 0
  return writeOpenRouter({
    catalog,
    pinned: autoPin ? recommendedPins(catalog) : prev.pinned,
    autoPinned: autoPin ? true : prev.autoPinned
  })
}

export async function openRouterStatus(): Promise<SettingsResult> {
  return { settings: await currentSettings() }
}

export async function saveOpenRouterKey(raw: unknown): Promise<SettingsResult> {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { settings: await currentSettings(), error: 'Paste an OpenRouter API key.' }
  }
  try {
    setSecret('openrouterApiKey', raw)
  } catch (err) {
    return {
      settings: await currentSettings(),
      error: err instanceof Error ? err.message : String(err)
    }
  }
  clearUsageCache()
  return refreshOpenRouterCatalog()
}

export async function clearOpenRouter(): Promise<SettingsResult> {
  clearSecret('openrouterApiKey')
  clearUsageCache()
  const settings = await loadSettings()
  const reset = settings.agent === 'openrouter'
  return { settings: await writeOpenRouter({}, reset) }
}

export async function refreshOpenRouterCatalog(): Promise<SettingsResult> {
  const key = peekSecret('openrouterApiKey')
  if (!key) return { settings: await currentSettings(), error: 'Save an OpenRouter API key first.' }
  try {
    return { settings: await applyCatalog(await fetchOpenRouterCatalog(key)) }
  } catch (err) {
    return {
      settings: await currentSettings(),
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function setOpenRouterPinned(ids: unknown): Promise<SettingsResult> {
  const pinned = uniqueIds(ids)
  const settings = await loadSettings()
  const reset = settings.agent === 'openrouter' && pinned.length === 0
  return { settings: await writeOpenRouter({ pinned }, reset) }
}
