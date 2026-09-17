/** Reads provider plan limits and the OpenRouter balance for the usage bar. */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { AI_PROVIDERS, type AiProvider } from '../shared/ai'
import { OPENROUTER_API_URL } from '../shared/openrouter'
import {
  FIVE_HOURS_MS,
  claudeTranscriptUsage,
  codexUsageWindows,
  parseOpenRouterCredits,
  parseOpenRouterKeyAllowance,
  type ProviderUsage,
  type UsageWindow
} from '../shared/usage'
import { peekSecret } from './secrets'

const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions')
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects')
const CACHE_MS = 60_000
const FETCH_TIMEOUT_MS = 8_000
const TAIL_BYTES = 512 * 1024

let cache: { at: number; rows: ProviderUsage[] } | null = null
let inflight: Promise<ProviderUsage[]> | null = null

/** Drop the cached readings after credentials change. */
export function clearUsageCache(): void {
  cache = null
}

function unavailable(provider: AiProvider, message: string, now: number): ProviderUsage {
  return { provider, state: 'unavailable', windows: [], message, updatedAt: now }
}

/** Every `.jsonl` file under `dir`, discovered with async I/O off the main thread. */
async function jsonl(dir: string, out: string[] = []): Promise<string[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return jsonl(full, out)
      if (entry.name.endsWith('.jsonl')) out.push(full)
      return Promise.resolve()
    })
  )
  return out
}

interface Transcript {
  file: string
  mtime: number
}

async function transcripts(dir: string): Promise<Transcript[]> {
  const files = await jsonl(dir)
  return Promise.all(
    files.map(async (file) => {
      try {
        return { file, mtime: (await fs.promises.stat(file)).mtimeMs }
      } catch {
        return { file, mtime: 0 }
      }
    })
  )
}

function newest(entries: readonly Transcript[]): string | null {
  let best: string | null = null
  let bestAt = 0
  for (const { file, mtime } of entries) {
    if (mtime > bestAt) {
      best = file
      bestAt = mtime
    }
  }
  return best
}

/** Last `maxBytes` of a file, dropping the leading partial line. */
async function readTail(file: string, maxBytes: number): Promise<string> {
  const handle = await fs.promises.open(file, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    const newline = text.indexOf('\n')
    return start > 0 && newline >= 0 ? text.slice(newline + 1) : text
  } finally {
    await handle.close()
  }
}

async function events(file: string): Promise<unknown[]> {
  const out: unknown[] = []
  let tail: string
  try {
    tail = await readTail(file, TAIL_BYTES)
  } catch {
    return out
  }
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* a torn or partial line */
    }
  }
  return out
}

async function codexUsage(now: number): Promise<ProviderUsage> {
  const file = newest(await transcripts(CODEX_SESSIONS))
  if (!file) return unavailable('codex', 'No Codex sessions found.', now)
  let windows: UsageWindow[] = []
  for (const event of await events(file)) {
    const next = codexUsageWindows((event as { payload?: unknown }).payload)
    if (next.length) windows = next
  }
  if (!windows.length) return unavailable('codex', 'The latest Codex session has no rate limits.', now)
  return { provider: 'codex', state: 'ok', windows, updatedAt: now }
}

async function claudeUsage(now: number): Promise<ProviderUsage> {
  const since = now - FIVE_HOURS_MS
  const recent = (await transcripts(CLAUDE_PROJECTS)).filter((entry) => entry.mtime >= since)
  if (!recent.length) return unavailable('claude', 'No Claude activity in the last 5 hours.', now)
  let windows: UsageWindow[] = []
  let tokens = 0
  for (const { file } of recent) {
    const parsed = claudeTranscriptUsage(await events(file), since)
    if (parsed.windows.length) windows = parsed.windows
    tokens += parsed.tokens
  }
  if (!windows.length && tokens === 0) return unavailable('claude', 'No Claude limits reported yet.', now)
  if (!windows.length) return { provider: 'claude', state: 'ok', windows: [{ label: '5h', tokens }], updatedAt: now }
  if (windows[0].tokens === undefined && tokens > 0) windows[0] = { ...windows[0], tokens }
  return { provider: 'claude', state: 'ok', windows, updatedAt: now }
}

async function getJson(url: string, key: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`OpenRouter responded ${res.status}.`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function openrouterUsage(now: number): Promise<ProviderUsage> {
  const key = peekSecret('openrouterApiKey')
  if (!key) return unavailable('openrouter', 'Add an OpenRouter API key in Settings.', now)
  const [credits, keyCredits] = await Promise.all([
    getJson(`${OPENROUTER_API_URL}/credits`, key)
      .then(parseOpenRouterCredits)
      .catch(() => undefined),
    getJson(`${OPENROUTER_API_URL}/key`, key)
      .then(parseOpenRouterKeyAllowance)
      .catch(() => undefined)
  ])
  if (credits === undefined && keyCredits === undefined) {
    return unavailable('openrouter', 'OpenRouter did not return a balance.', now)
  }
  return {
    provider: 'openrouter',
    state: 'ok',
    windows: [],
    ...(credits !== undefined ? { credits } : {}),
    ...(keyCredits !== undefined ? { keyCredits } : {}),
    ...(credits === undefined
      ? { message: 'Account credits need a management key; showing key allowance.' }
      : {}),
    updatedAt: now
  }
}

async function readAll(now: number): Promise<ProviderUsage[]> {
  const [claude, codex, openrouter] = await Promise.all([
    claudeUsage(now),
    codexUsage(now),
    openrouterUsage(now)
  ])
  const rows: Record<AiProvider, ProviderUsage> = {
    claude,
    codex,
    cursor: unavailable('cursor', 'Cursor limits need a team Admin API key.', now),
    opencode: unavailable('opencode', 'No host quota; usage follows the selected model.', now),
    omp: unavailable('omp', 'No host quota; usage follows the selected model.', now),
    openrouter
  }
  return AI_PROVIDERS.map((provider) => rows[provider])
}

/** Cached readings for every provider, refreshed at most once a minute. */
export function providerUsage(): Promise<ProviderUsage[]> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return Promise.resolve(cache.rows)
  if (inflight) return inflight
  inflight = readAll(now)
    .then((rows) => {
      cache = { at: Date.now(), rows }
      return rows
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
