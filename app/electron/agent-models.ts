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
  parseClaudeHelp,
  parseClaudeModelOptions,
  parseCodexModelsCache,
  parseCursorModels,
  parseOmpModelsJson,
  parseOpenCodeModels,
  uniqueModels
} from '../shared/agent-models'
import { resolveBinFrom } from './bin'
import { execCli } from './exec-cli'
import { loadSettings, saveAgentCatalogs } from './store'

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

async function discoverClaude(): Promise<AiModel[]> {
  const text = await runBin(['claude'], ['--help'])
  const fromHelp = text ? parseClaudeHelp(text) : []
  return uniqueModels([...fromHelp, ...readClaudeOptionsCache(), ...AI_MODELS.claude])
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
