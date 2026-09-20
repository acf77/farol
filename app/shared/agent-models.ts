/** Parse live model catalogs each coding CLI can expose. */

import type { AiCli, AiModel } from './ai'

/**
 * Providers Farol discovers from a local CLI or its cache (not OpenRouter's
 * HTTP API, and not Claude — which has no machine-readable model list).
 */
export const DISCOVERABLE_PROVIDERS = ['codex', 'cursor', 'opencode', 'omp'] as const satisfies readonly AiCli[]
export type DiscoverableProvider = (typeof DISCOVERABLE_PROVIDERS)[number]

export type AgentCatalogs = Partial<Record<DiscoverableProvider, AiModel[]>>

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

function modelsArray(body: unknown): unknown[] {
  const models = asRecord(body)?.models
  return Array.isArray(models) ? models : []
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Deduplicate by id, keeping the first label. */
export function uniqueModels(rows: readonly AiModel[]): AiModel[] {
  const out: AiModel[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const id = row.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const label = row.label.trim() || id
    out.push({ id, label })
  }
  return out
}

/** `agent --list-models` lines: `id - Label (notes)`. */
export function parseCursorModels(text: string): AiModel[] {
  const out: AiModel[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || /^available models$/i.test(trimmed)) continue
    const m = /^(\S+)\s+-\s+(.+)$/.exec(trimmed)
    if (!m) continue
    const id = m[1]
    // Drop parenthetical status like "(current, default)" from the label.
    const label = m[2].replace(/\s*\([^)]*\)\s*$/, '').trim() || id
    out.push({ id, label })
  }
  return uniqueModels(out)
}

/** `opencode models` prints one `provider/model` id per line. */
export function parseOpenCodeModels(text: string): AiModel[] {
  const out: AiModel[] = []
  for (const line of text.split(/\r?\n/)) {
    const id = line.trim()
    if (!id || id.startsWith('Error') || id.toLowerCase().includes('not found')) continue
    // Skip banner / help noise.
    if (/\s/.test(id)) continue
    const slash = id.indexOf('/')
    const label = slash >= 0 ? id.slice(slash + 1) : id
    out.push({ id, label })
  }
  return uniqueModels(out)
}

function codexModelFromRow(row: unknown): AiModel | null {
  const rec = asRecord(row)
  if (!rec || rec.visibility === 'hide' || rec.supported_in_api === false) return null
  const id = trimmedString(rec.slug)
  if (!id) return null
  return { id, label: trimmedString(rec.display_name) || id }
}

/** `~/.codex/models_cache.json` — keep rows the TUI would list. */
export function parseCodexModelsCache(body: unknown): AiModel[] {
  const out: AiModel[] = []
  for (const row of modelsArray(body)) {
    const model = codexModelFromRow(row)
    if (model) out.push(model)
  }
  return uniqueModels(out)
}

function ompSelector(rec: Record<string, unknown>, short: string): string {
  const selector = trimmedString(rec.selector)
  if (selector) return selector
  const provider = trimmedString(rec.provider)
  return provider ? `${provider}/${short}` : short
}

function countOmpIds(rows: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const id = trimmedString(asRecord(row)?.id)
    if (id) counts.set(id, (counts.get(id) || 0) + 1)
  }
  return counts
}

function ompModelFromRow(row: unknown, counts: Map<string, number>): AiModel | null {
  const rec = asRecord(row)
  if (!rec) return null
  const short = trimmedString(rec.id)
  if (!short) return null
  const selector = ompSelector(rec, short)
  const duplicate = (counts.get(short) || 0) > 1
  return {
    id: duplicate ? selector : short,
    label: trimmedString(rec.name) || short
  }
}

/** `omp models --json` — short `id` when unique, else `provider/id`. */
export function parseOmpModelsJson(body: unknown): AiModel[] {
  const rows = modelsArray(body)
  const counts = countOmpIds(rows)
  const out: AiModel[] = []
  for (const row of rows) {
    const model = ompModelFromRow(row, counts)
    if (model) out.push(model)
  }
  return uniqueModels(out)
}

/** Merge non-empty discoveries over the previous catalogs; keep stale on failure. */
export function mergeCatalogs(
  prev: AgentCatalogs | undefined,
  discovered: AgentCatalogs
): AgentCatalogs {
  const next: AgentCatalogs = { ...prev }
  for (const [key, models] of Object.entries(discovered) as [
    DiscoverableProvider,
    AiModel[] | undefined
  ][]) {
    if (models && models.length) next[key] = models
  }
  return next
}
