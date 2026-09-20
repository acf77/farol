/** Discover per-CLI model catalogs and persist them on settings. */

import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AiModel, SettingsResult } from '../shared/types'
import {
  DISCOVERABLE_PROVIDERS,
  type AgentCatalogs,
  type DiscoverableProvider,
  mergeCatalogs,
  parseCodexModelsCache,
  parseCursorModels,
  parseOmpModelsJson,
  parseOpenCodeModels
} from '../shared/agent-models'
import { resolveBinFrom } from './bin'
import { execCli } from './exec-cli'
import { loadSettings, saveSettings } from './store'

const LIST_TIMEOUT_MS = 45_000

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

async function discoverCodex(): Promise<AiModel[]> {
  const cache = path.join(os.homedir(), '.codex', 'models_cache.json')
  try {
    const raw = JSON.parse(fs.readFileSync(cache, 'utf8')) as unknown
    return parseCodexModelsCache(raw)
  } catch {
    return []
  }
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
    case 'cursor':
      return discoverCursor()
    case 'codex':
      return discoverCodex()
    case 'opencode':
      return discoverOpenCode(forceRefresh)
    case 'omp':
      return discoverOmp(forceRefresh)
  }
}

export async function refreshAgentCatalogs(opts?: {
  forceRefresh?: boolean
}): Promise<SettingsResult> {
  const forceRefresh = opts?.forceRefresh === true
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

  const settings = await loadSettings()
  await saveSettings({ ...settings, catalogs: mergeCatalogs(settings.catalogs, discovered) })
  // `loadSettings` re-reads the persisted catalogs and applies the key flags.
  return { settings: await loadSettings() }
}
