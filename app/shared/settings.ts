/** Machine-scoped preferences — which agent to hand work to, and when. */

import { isAiProvider, normalizeModel, type AiModel, type AiProvider } from './ai'
import { uniqueIds } from './openrouter'

export interface OpenRouterSettings {
  pinned: string[]
  catalog: AiModel[]
  /** True after the first successful auto-pin so Refresh does not restore defaults. */
  autoPinned: boolean
  /** Runtime flag from the encrypted store — not persisted. */
  hasKey?: boolean
}

export interface AppSettings {
  /** The CLI that failed pipeline steps get handed to. */
  agent: AiProvider
  /** Default `--model` id per CLI. A missing entry means the CLI's own default. */
  models: Partial<Record<AiProvider, string>>
  /** Hand a failure straight to the agent instead of waiting to be asked. */
  autoFix: boolean
  openrouter?: OpenRouterSettings
}

export function defaultSettings(): AppSettings {
  return { agent: 'claude', models: {}, autoFix: true }
}

/** Set or clear one CLI's default model; an empty id falls back to the CLI's own. */
export function withAgentModel(
  settings: AppSettings,
  provider: AiProvider,
  model?: string
): AppSettings {
  const models = { ...settings.models }
  const id = normalizeModel(model)
  if (id) models[provider] = id
  else delete models[provider]
  return { ...settings, models }
}

export function defaultOpenRouter(): OpenRouterSettings {
  return { pinned: [], catalog: [], autoPinned: false }
}

function sanitizeCatalog(raw: unknown): AiModel[] {
  if (!Array.isArray(raw)) return []
  const out: AiModel[] = []
  const seen = new Set<string>()
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const rec = row as { id?: unknown; label?: unknown }
    if (typeof rec.id !== 'string') continue
    const id = rec.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const label = typeof rec.label === 'string' && rec.label.trim() ? rec.label.trim() : id
    out.push({ id, label })
  }
  return out
}

export function sanitizeOpenRouter(raw: unknown): OpenRouterSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const pinned = uniqueIds(o.pinned)
  const catalog = sanitizeCatalog(o.catalog)
  const autoPinned = o.autoPinned === true
  if (!pinned.length && !catalog.length && !autoPinned) return undefined
  return { pinned, catalog, autoPinned }
}

export function withOpenRouterKeyFlag(settings: AppSettings, hasKey: boolean): AppSettings {
  if (!hasKey && !settings.openrouter) return settings
  return {
    ...settings,
    openrouter: { ...defaultOpenRouter(), ...settings.openrouter, hasKey }
  }
}

function sanitizeModels(raw: unknown): Partial<Record<AiProvider, string>> {
  const out: Partial<Record<AiProvider, string>> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [provider, value] of Object.entries(raw)) {
    const id = normalizeModel(value)
    if (id && isAiProvider(provider)) out[provider] = id
  }
  return out
}

export function sanitizeSettings(raw: unknown): AppSettings {
  const d = defaultSettings()
  if (!raw || typeof raw !== 'object') return d
  const s = raw as Record<string, unknown>
  const agent = isAiProvider(s.agent) ? s.agent : d.agent
  const models = sanitizeModels(s.models)
  // Settings written before per-agent models held one `model`, for `agent`.
  const legacy = normalizeModel(s.model)
  if (legacy && !models[agent]) models[agent] = legacy
  const openrouter = sanitizeOpenRouter(s.openrouter)
  return {
    agent,
    models,
    autoFix: typeof s.autoFix === 'boolean' ? s.autoFix : d.autoFix,
    ...(openrouter ? { openrouter } : {})
  }
}
