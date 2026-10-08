/** API spend by day and model, read from each provider's admin usage endpoints. */

export const SPEND_PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const
export type SpendProvider = (typeof SPEND_PROVIDERS)[number]

export const SPEND_LABELS: Record<SpendProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter'
}

/** Keys that unlock the reports; separate from the keys the CLIs run with. */
export const SPEND_KEY_HINTS: Record<SpendProvider, { label: string; placeholder: string; help: string }> = {
  anthropic: { label: 'Anthropic admin key', placeholder: 'sk-ant-admin…', help: 'Organization accounts only.' },
  openai: { label: 'OpenAI admin key', placeholder: 'sk-admin-…', help: 'Organization owners can create one.' },
  openrouter: { label: 'OpenRouter management key', placeholder: 'sk-or-…', help: 'Shows the last 30 days.' }
}

/** Days fetched per report; OpenRouter only keeps 30. */
export const SPEND_DAYS = 90

export interface SpendDay {
  /** UTC `YYYY-MM-DD`. */
  date: string
  input: number
  output: number
  /** USD. */
  cost: number
}

export interface ModelSpend {
  id: string
  name: string
  days: SpendDay[]
}

export interface ProviderSpend {
  provider: SpendProvider
  state: 'ok' | 'no-key' | 'error'
  message?: string
  models: ModelSpend[]
}

export interface SpendReport {
  providers: ProviderSpend[]
  /** Epoch ms. */
  fetchedAt: number
}

export type SpendKeyStatus = Record<SpendProvider, boolean>

function finite(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isoDay(raw: unknown): string | null {
  if (typeof raw === 'number') return new Date(raw * 1000).toISOString().slice(0, 10)
  if (typeof raw !== 'string') return null
  const t = Date.parse(raw)
  return Number.isNaN(t) ? raw.slice(0, 10) || null : new Date(t).toISOString().slice(0, 10)
}

/** Accumulates per-model, per-day figures from any provider's rows. */
export class SpendBook {
  private models = new Map<string, { name: string; days: Map<string, SpendDay> }>()

  add(id: string, name: string, date: string | null, part: Partial<Omit<SpendDay, 'date'>>): void {
    if (!id || !date) return
    let model = this.models.get(id)
    if (!model) {
      model = { name, days: new Map() }
      this.models.set(id, model)
    }
    const day = model.days.get(date) ?? { date, input: 0, output: 0, cost: 0 }
    day.input += part.input ?? 0
    day.output += part.output ?? 0
    day.cost += part.cost ?? 0
    model.days.set(date, day)
  }

  result(): ModelSpend[] {
    return [...this.models].map(([id, m]) => ({
      id,
      name: m.name,
      days: [...m.days.values()].sort((a, b) => a.date.localeCompare(b.date))
    }))
  }
}

/** Anthropic `usage_report/messages` buckets grouped by model. */
export function addAnthropicUsage(book: SpendBook, body: unknown): void {
  for (const bucket of list(record(body)?.data)) {
    const date = isoDay(record(bucket)?.starting_at)
    for (const raw of list(record(bucket)?.results)) {
      const r = record(raw)
      const model = typeof r?.model === 'string' ? r.model : ''
      const creation = record(r?.cache_creation)
      const input =
        finite(r?.uncached_input_tokens) +
        finite(r?.cache_read_input_tokens) +
        finite(creation?.ephemeral_1h_input_tokens) +
        finite(creation?.ephemeral_5m_input_tokens)
      book.add(model, model, date, { input, output: finite(r?.output_tokens) })
    }
  }
}

/** Anthropic `cost_report` buckets grouped by description; amounts are cents. */
export function addAnthropicCost(book: SpendBook, body: unknown): void {
  for (const bucket of list(record(body)?.data)) {
    const date = isoDay(record(bucket)?.starting_at)
    for (const raw of list(record(bucket)?.results)) {
      const r = record(raw)
      const model = typeof r?.model === 'string' ? r.model : ''
      if (model) book.add(model, model, date, { cost: finite(r?.amount) / 100 })
    }
  }
}

/** OpenAI `usage/completions` buckets grouped by model. */
export function addOpenAIUsage(book: SpendBook, body: unknown): void {
  for (const bucket of list(record(body)?.data)) {
    const date = isoDay(record(bucket)?.start_time)
    for (const raw of list(record(bucket)?.results)) {
      const r = record(raw)
      const model = typeof r?.model === 'string' ? r.model : ''
      book.add(model, model, date, { input: finite(r?.input_tokens), output: finite(r?.output_tokens) })
    }
  }
}

/** `gpt-5, input` → `gpt-5`: line items carry a token-kind suffix. */
export function lineItemModel(lineItem: string): string {
  return lineItem.replace(/,\s*(cached\s+)?(input|output)s?$/i, '').trim()
}

/** OpenAI `costs` buckets grouped by line item, already in dollars. */
export function addOpenAICost(book: SpendBook, body: unknown): void {
  for (const bucket of list(record(body)?.data)) {
    const date = isoDay(record(bucket)?.start_time)
    for (const raw of list(record(bucket)?.results)) {
      const r = record(raw)
      const item = typeof r?.line_item === 'string' ? lineItemModel(r.line_item) : ''
      book.add(item, item, date, { cost: finite(record(r?.amount)?.value) })
    }
  }
}

/** OpenRouter `/activity` rows: one per day and model. */
export function addOpenRouterActivity(book: SpendBook, body: unknown): void {
  for (const raw of list(record(body)?.data)) {
    const r = record(raw)
    const model = typeof r?.model === 'string' ? r.model : ''
    book.add(model, model, isoDay(r?.date), {
      input: finite(r?.prompt_tokens),
      output: finite(r?.completion_tokens),
      cost: finite(r?.usage)
    })
  }
}

// ---- Renderer-side views over a report ------------------------------------

export interface ModelTotal {
  id: string
  name: string
  input: number
  output: number
  cost: number
}

export interface ProviderTotal {
  provider: SpendProvider
  models: ModelTotal[]
  cost: number
  tokens: number
}

/** Models summed over dates on or after `from`, biggest spend first. */
export function totalsSince(spend: ProviderSpend, from: string): ProviderTotal {
  const models = spend.models
    .map((m): ModelTotal => {
      const t = { id: m.id, name: m.name, input: 0, output: 0, cost: 0 }
      for (const d of m.days) {
        if (d.date < from) continue
        t.input += d.input
        t.output += d.output
        t.cost += d.cost
      }
      return t
    })
    .filter((m) => m.cost > 0 || m.input > 0 || m.output > 0)
    .sort((a, b) => b.cost - a.cost || b.input + b.output - (a.input + a.output))
  return {
    provider: spend.provider,
    models,
    cost: models.reduce((t, m) => t + m.cost, 0),
    tokens: models.reduce((t, m) => t + m.input + m.output, 0)
  }
}

/** Spend per UTC day for one provider. */
export function dailyCost(spend: ProviderSpend): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of spend.models) for (const d of m.days) out.set(d.date, (out.get(d.date) ?? 0) + d.cost)
  return out
}

/** UTC `YYYY-MM-DD` for `days` before `today`. */
export function daysAgo(today: Date, days: number): string {
  return new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10)
}

/** Heat level 0–4 from quartile-ish cuts over the non-zero days. */
export function heatCuts(values: readonly number[]): [number, number, number] {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b)
  const q = (k: number): number => sorted[Math.floor(sorted.length * k)] ?? 0
  return [q(0.25), q(0.5), q(0.8)]
}

export function heatLevel(value: number, cuts: readonly number[]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0
  if (value <= cuts[0]) return 1
  if (value <= cuts[1]) return 2
  if (value <= cuts[2]) return 3
  return 4
}

export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return '<$0.01'
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
