/** Discover per-CLI model catalogs and persist them on settings. */

import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AiModel, SettingsResult } from '../shared/types'
import { AI_MODELS } from '../shared/ai'
import {
  DISCOVERABLE_PROVIDERS,
  type AgentCatalogs,
  type DiscoverableProvider,
  finalizeClaudeCatalog,
  parseClaudeHelp,
  parseClaudeModelOptions,
  parseAnthropicModels,
  parseCodexModelsCache,
  parseCursorModels,
  parseOmpModelsJson,
  parseOpenCodeModels,
  parseOpenRouterClaudeAliases,
  uniqueModels
} from '../shared/agent-models'
import { OPENROUTER_MODELS_URL } from '../shared/openrouter'
import { providerKeyOff } from './provider-keys-off'
import { peekSecret } from './secrets'
import { resolveBinFrom } from './bin'
import { execCli } from './exec-cli'
import { loadSettings, saveAgentCatalogs } from './store'

const LIST_TIMEOUT_MS = 45_000
/** Metadata fetches run in sequence, so each stays short. */
const FETCH_TIMEOUT_MS = 10_000

async function runBin(
  bins: string[],
  args: string[],
  timeout = LIST_TIMEOUT_MS
): Promise<string | null> {
  const bin = resolveBinFrom(bins)
  if (!bin) return null
  const { code, out, err } = await execCli(bin, os.homedir(), args, timeout)
  if (code !== 0) return null
  const text = out.trim() || err.trim()
  return text || null
}

async function discoverCursor(): Promise<AiModel[]> {
  const text = await runBin(['agent', 'cursor-agent'], ['--list-models'])
  return text ? parseCursorModels(text) : []
}

function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
}

function readCodexCache(): AiModel[] {
  try {
    return parseCodexModelsCache(readJsonFile(path.join(os.homedir(), '.codex', 'models_cache.json')))
  } catch {
    return []
  }
}

function readClaudeOptionsCache(): AiModel[] {
  try {
    const raw = readJsonFile(path.join(os.homedir(), '.claude.json'))
    const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
    return parseClaudeModelOptions(rec?.additionalModelOptionsCache)
  } catch {
    return []
  }
}

/** Newest model per line with its context window; empty when offline or rejected. */
async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers })
    return res.ok ? ((await res.json()) as unknown) : null
  } catch {
    return null
  }
}

async function fetchClaudeAliases(): Promise<AiModel[]> {
  const key = providerKeyOff('anthropic') ? null : peekSecret('anthropicApiKey')
  if (key) {
    const body = await fetchJson('https://api.anthropic.com/v1/models?limit=1000', {
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    })
    const aliases = parseAnthropicModels(body)
    if (aliases.length) return aliases
  }
  // No usable key (missing, switched off or rejected): the public catalog still has the windows.
  return parseOpenRouterClaudeAliases(await fetchJson(OPENROUTER_MODELS_URL))
}

async function discoverClaude(): Promise<AiModel[]> {
  const [live, text] = await Promise.all([fetchClaudeAliases(), runBin(['claude'], ['--help'])])
  const fromHelp = text ? parseClaudeHelp(text) : []
  const local = finalizeClaudeCatalog([...fromHelp, ...readClaudeOptionsCache(), ...AI_MODELS.claude])
  // Per alias the order is live, then the last discovered catalog, then local, so a partial reply keeps known windows.
  const cached = (await loadSettings()).catalogs?.claude ?? []
  // A live row without a window takes the saved one, but only for the same model version (same label).
  const withWindow = (m: AiModel): AiModel =>
    m.contextWindow ? m : { ...m, contextWindow: cached.find((c) => c.id === m.id && c.label === m.label)?.contextWindow }
  return uniqueModels([...live.map(withWindow), ...cached, ...local])
}

async function discoverCodex(forceRefresh: boolean): Promise<AiModel[]> {
  if (!forceRefresh) {
    const cached = readCodexCache()
    if (cached.length) return cached
  }
  const text = await runBin(['codex'], ['debug', 'models'])
  if (text) {
    try {
      const parsed = parseCodexModelsCache(JSON.parse(text) as unknown)
      if (parsed.length) return parsed
    } catch {
      /* fall through to the on-disk cache */
    }
  }
  return readCodexCache()
}

async function discoverOpenCode(forceRefresh: boolean): Promise<AiModel[]> {
  const args = forceRefresh ? ['models', '--refresh'] : ['models']
  const text = await runBin(['opencode'], args)
  return text ? parseOpenCodeModels(text) : []
}

async function discoverOmp(forceRefresh: boolean): Promise<AiModel[]> {
  if (forceRefresh) {
    // Best-effort catalog pull; listing still works from the local db if this fails.
    await runBin(['omp'], ['models', 'refresh'], LIST_TIMEOUT_MS)
  }
  const text = await runBin(['omp'], ['models', '--json'])
  if (!text) return []
  try {
    return parseOmpModelsJson(JSON.parse(text) as unknown)
  } catch {
    return []
  }
}

async function discoverOne(
  provider: DiscoverableProvider,
  forceRefresh: boolean
): Promise<AiModel[]> {
  switch (provider) {
    case 'claude':
      return discoverClaude()
    case 'cursor':
      return discoverCursor()
    case 'codex':
      return discoverCodex(forceRefresh)
    case 'opencode':
      return discoverOpenCode(forceRefresh)
    case 'omp':
      return discoverOmp(forceRefresh)
  }
}

let catalogRefresh: Promise<unknown> = Promise.resolve()

async function refreshNow(forceRefresh: boolean): Promise<SettingsResult> {
  const settled = await Promise.all(
    DISCOVERABLE_PROVIDERS.map(async (provider) => {
      try {
        return [provider, await discoverOne(provider, forceRefresh)] as const
      } catch {
        return [provider, [] as AiModel[]] as const
      }
    })
  )
  const discovered: AgentCatalogs = {}
  for (const [provider, models] of settled) {
    if (models.length) discovered[provider] = models
  }
  await saveAgentCatalogs(discovered)
  return { settings: await loadSettings() }
}

export async function refreshAgentCatalogs(opts?: {
  forceRefresh?: boolean
}): Promise<SettingsResult> {
  const forceRefresh = opts?.forceRefresh === true
  const run = catalogRefresh.then(
    () => refreshNow(forceRefresh),
    () => refreshNow(forceRefresh)
  )
  catalogRefresh = run
  return run
}
