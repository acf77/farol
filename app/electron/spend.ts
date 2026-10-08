/** Fetches API spend from each provider's admin endpoints, cached for a few minutes. */

import { OPENROUTER_API_URL } from '../shared/openrouter'
import {
  SPEND_DAYS,
  SPEND_PROVIDERS,
  SpendBook,
  addAnthropicCost,
  addAnthropicUsage,
  addOpenAICost,
  addOpenAIUsage,
  addOpenRouterActivity,
  type ProviderSpend,
  type SpendKeyStatus,
  type SpendProvider,
  type SpendReport
} from '../shared/spend'
import { errorMessage } from '../shared/jev'
import { clearSecret, hasSecret, peekSecret, setSecret, type SecretName } from './secrets'

const CACHE_MS = 5 * 60_000
const FETCH_TIMEOUT_MS = 15_000
const MAX_PAGES = 8
const PAGE_DAYS = 31
const DAY_MS = 86_400_000

const SECRETS: Record<SpendProvider, SecretName> = {
  anthropic: 'anthropicAdminKey',
  openai: 'openaiAdminKey',
  openrouter: 'openrouterManagementKey'
}

let cache: { at: number; report: SpendReport } | null = null
let inflight: Promise<SpendReport> | null = null

export function isSpendProvider(value: unknown): value is SpendProvider {
  return (SPEND_PROVIDERS as readonly unknown[]).includes(value)
}

export function spendKeyStatus(): SpendKeyStatus {
  return {
    anthropic: hasSecret(SECRETS.anthropic),
    openai: hasSecret(SECRETS.openai),
    openrouter: hasSecret(SECRETS.openrouter)
  }
}

export function saveSpendKey(name: unknown, raw: unknown): { status: SpendKeyStatus; error?: string } {
  if (!isSpendProvider(name)) return { status: spendKeyStatus(), error: 'Unknown provider.' }
  if (typeof raw !== 'string' || !raw.trim()) return { status: spendKeyStatus(), error: 'Paste a key.' }
  try {
    setSecret(SECRETS[name], raw)
  } catch (err) {
    return { status: spendKeyStatus(), error: errorMessage(err) }
  }
  cache = null
  return { status: spendKeyStatus() }
}

export function clearSpendKey(name: unknown): { status: SpendKeyStatus } {
  if (isSpendProvider(name)) {
    clearSecret(SECRETS[name])
    cache = null
  }
  return { status: spendKeyStatus() }
}

async function getJson(url: URL, headers: Record<string, string>, label: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${label} rejected the key. It needs to be an admin key.`)
    }
    if (!res.ok) throw new Error(`${label} responded ${res.status}.`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Follow `next_page` cursors, handing each body to `sink`. */
async function paged(
  url: (page: string | null) => URL,
  headers: Record<string, string>,
  label: string,
  sink: (body: unknown) => void
): Promise<void> {
  let page: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = await getJson(url(page), headers, label)
    sink(body)
    const next = (body as { has_more?: boolean; next_page?: unknown } | null)
    page = next?.has_more && typeof next.next_page === 'string' ? next.next_page : null
    if (!page) return
  }
}

function startOfDay(now: number, daysBack: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS - daysBack * DAY_MS
}

/** Midnight UTC tonight: reports leave out buckets that end after this, so it must cover today. */
function endOfToday(now: number): number {
  return startOfDay(now, -1)
}

async function anthropicSpend(key: string, now: number): Promise<ProviderSpend> {
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  const base = 'https://api.anthropic.com/v1/organizations'
  const startingAt = new Date(startOfDay(now, SPEND_DAYS - 1)).toISOString()
  const endingAt = new Date(endOfToday(now)).toISOString()
  const book = new SpendBook()
  const query = (path: string, group: string[]) => (page: string | null) => {
    const u = new URL(`${base}/${path}`)
    u.searchParams.set('starting_at', startingAt)
    u.searchParams.set('ending_at', endingAt)
    u.searchParams.set('bucket_width', '1d')
    u.searchParams.set('limit', String(PAGE_DAYS))
    for (const g of group) u.searchParams.append('group_by[]', g)
    if (page) u.searchParams.set('page', page)
    return u
  }
  await Promise.all([
    paged(query('usage_report/messages', ['model']), headers, 'Anthropic', (b) => addAnthropicUsage(book, b)),
    paged(query('cost_report', ['description']), headers, 'Anthropic', (b) => addAnthropicCost(book, b))
  ])
  return { provider: 'anthropic', state: 'ok', models: book.result() }
}

async function openaiSpend(key: string, now: number): Promise<ProviderSpend> {
  const headers = { Authorization: `Bearer ${key}` }
  const base = 'https://api.openai.com/v1/organization'
  const start = Math.floor(startOfDay(now, SPEND_DAYS - 1) / 1000)
  const end = Math.floor(endOfToday(now) / 1000)
  const book = new SpendBook()
  const query = (path: string, group: string) => (page: string | null) => {
    const u = new URL(`${base}/${path}`)
    u.searchParams.set('start_time', String(start))
    u.searchParams.set('end_time', String(end))
    u.searchParams.set('bucket_width', '1d')
    u.searchParams.set('limit', String(PAGE_DAYS))
    u.searchParams.append('group_by', group)
    if (page) u.searchParams.set('page', page)
    return u
  }
  await Promise.all([
    paged(query('usage/completions', 'model'), headers, 'OpenAI', (b) => addOpenAIUsage(book, b)),
    paged(query('costs', 'line_item'), headers, 'OpenAI', (b) => addOpenAICost(book, b))
  ])
  return { provider: 'openai', state: 'ok', models: book.result() }
}

async function openrouterSpend(key: string): Promise<ProviderSpend> {
  const book = new SpendBook()
  const body = await getJson(
    new URL(`${OPENROUTER_API_URL.replace(/\/$/, '')}/activity`),
    { Authorization: `Bearer ${key}` },
    'OpenRouter'
  )
  addOpenRouterActivity(book, body)
  return { provider: 'openrouter', state: 'ok', models: book.result() }
}

async function oneProvider(provider: SpendProvider, now: number): Promise<ProviderSpend> {
  const key = peekSecret(SECRETS[provider])
  if (!key) return { provider, state: 'no-key', models: [] }
  try {
    if (provider === 'anthropic') return await anthropicSpend(key, now)
    if (provider === 'openai') return await openaiSpend(key, now)
    return await openrouterSpend(key)
  } catch (err) {
    return { provider, state: 'error', message: errorMessage(err), models: [] }
  }
}

/** Cached spend for every provider; `force` skips the cache. */
export function readSpend(force?: unknown): Promise<SpendReport> {
  const now = Date.now()
  if (force !== true && cache && now - cache.at < CACHE_MS) return Promise.resolve(cache.report)
  if (inflight) return inflight
  inflight = Promise.all(SPEND_PROVIDERS.map((p) => oneProvider(p, now)))
    .then((providers) => {
      const report: SpendReport = { providers, fetchedAt: Date.now() }
      cache = { at: report.fetchedAt, report }
      return report
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
