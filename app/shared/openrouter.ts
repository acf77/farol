/** OpenRouter catalog, pins, and the OpenCode model id Farol passes through. */

import type { AiModel } from './ai'

export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1'
export const OPENROUTER_MODELS_URL = `${OPENROUTER_API_URL}/models`
export const OPENROUTER_API_KEY_ENV = 'OPENROUTER_API_KEY'

/** Well-known tool-capable ids, one family each. First match in the catalog wins. */
export const OPENROUTER_RECOMMENDED_IDS = [
  'anthropic/claude-sonnet-4',
  'anthropic/claude-3.7-sonnet',
  'anthropic/claude-3.5-sonnet',
  'openai/gpt-4o',
  'openai/gpt-4.1',
  'google/gemini-2.5-flash',
  'google/gemini-2.0-flash-001',
  'x-ai/grok-4',
  'x-ai/grok-3-beta'
] as const

const FAMILIES: ((id: string) => boolean)[] = [
  (id) => id.startsWith('anthropic/claude') && id.includes('sonnet'),
  (id) => id.startsWith('openai/gpt-') && !id.includes('mini') && !id.includes('nano'),
  (id) => id.startsWith('google/gemini'),
  (id) => id.startsWith('x-ai/grok')
]

export function isToolCapable(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const params = (raw as { supported_parameters?: unknown }).supported_parameters
  return Array.isArray(params) && params.includes('tools')
}

export function parseOpenRouterCatalog(body: unknown): AiModel[] {
  if (!body || typeof body !== 'object') return []
  const rows = (body as { data?: unknown }).data
  if (!Array.isArray(rows)) return []
  const out: AiModel[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!isToolCapable(row) || !row || typeof row !== 'object') continue
    const rec = row as { id?: unknown; name?: unknown }
    if (typeof rec.id !== 'string') continue
    const id = rec.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const label = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : id
    out.push({ id, label })
  }
  return out
}

/** Pin one recommended model per family when those ids exist; otherwise the first four. */
export function recommendedPins(catalog: readonly AiModel[]): string[] {
  const available = new Set(catalog.map((m) => m.id))
  const pinned: string[] = []
  const used = new Set<number>()
  for (const id of OPENROUTER_RECOMMENDED_IDS) {
    if (!available.has(id)) continue
    const family = FAMILIES.findIndex((test) => test(id))
    if (family >= 0) {
      if (used.has(family)) continue
      used.add(family)
    }
    pinned.push(id)
  }
  if (pinned.length) return pinned
  return catalog.slice(0, 4).map((m) => m.id)
}

/** OpenCode's `--model` id for an OpenRouter catalog slug. */
export function openCodeModel(model?: string): string | undefined {
  if (!model) return undefined
  const id = model.trim()
  if (!id) return undefined
  return id.startsWith('openrouter/') ? id : `openrouter/${id}`
}

export function uniqueIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of ids) {
    if (typeof value !== 'string') continue
    const id = value.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
