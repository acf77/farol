/** Machine-scoped preferences — which agent to hand work to, and when. */

import {
  isAiProvider,
  normalizeMode,
  normalizeModel,
  normalizeOpenRouterAgent,
  type AgentMode,
  type AiModel,
  type AiProvider,
  type OpenRouterAgent
} from './ai'
import {
  DISCOVERABLE_PROVIDERS,
  type AgentCatalogs,
  type DiscoverableProvider
} from './agent-models'
import { uniqueIds } from './openrouter'

export interface OpenRouterSettings {
  pinned: string[]
  catalog: AiModel[]
  /** True after the first successful auto-pin so Refresh does not restore defaults. */
  autoPinned: boolean
  /** The CLI OpenRouter runs through. Absent means OpenCode, the original backend. */
  agent?: OpenRouterAgent
  /** Runtime flag from the encrypted store — not persisted. */
  hasKey?: boolean
}

/**
 * Jev is internal-only, so the single thing to configure is whether Farol holds
 * a Vercel AI Gateway key. The flag comes from the encrypted store on load and
 * is never persisted.
 */
export interface JevSettings {
  hasKey: boolean
}

/** What a key mutation hands back: the settings to adopt, plus why it failed. */
export interface SettingsResult {
  settings: AppSettings
  error?: string
}

/**
 * Who this machine is signed in to the remote pipeline service as. The service's
 * address is built into the app; the session token stays in the main process.
 */
export type RemoteAccount =
  | { state: 'signedOut'; message?: string }
  | {
      state: 'signedIn'
      login: string
      displayName?: string
      /** The GitHub avatar as a `data:` URL; the renderer cannot load remote images. */
      avatar?: string
    }
  | { state: 'error'; message: string }

/** Device-flow sign-in, step 1: show `userCode`; the browser is already open at `verificationUri`. */
export type RemoteSignInStart = { userCode: string; verificationUri: string } | { error: string }

/** One rung of a mode's fallback chain: a CLI, optionally pinned to a model. */
export interface ModelChoice {
  agent: AiProvider
  model?: string
}

/** Ordered per-mode chains. The first rung starts a chat; the rest are fallbacks. */
export type ModeDefaults = Record<AgentMode, ModelChoice[]>

export interface AppSettings {
  /** The CLI that failed pipeline steps get handed to. */
  agent: AiProvider
  /** Default `--model` id per CLI. A missing entry means the CLI's own default. */
  models: Partial<Record<AiProvider, string>>
  /** The AI used only to draft Git commit messages. */
  commitMessage: { agent: AiProvider; model?: string }
  /** Hand a failure straight to the agent instead of waiting to be asked. */
  autoFix: boolean
  /**
   * Which model each chat mode opens with, and which to try when one fails.
   * An empty chain means the mode just uses `agent` / `models[agent]`.
   */
  modeDefaults: ModeDefaults
  /** Models tried, in order, when an AI pipeline step's own model is missing or hits a provider limit. Empty means no fallback. */
  pipelineFallbacks: ModelChoice[]
  openrouter?: OpenRouterSettings
  /** Live `--model` catalogs discovered from each local CLI. */
  catalogs?: AgentCatalogs
  /** Absent until an AI Gateway key is stored. */
  jev?: JevSettings
}

export function defaultSettings(): AppSettings {
  return {
    agent: 'claude',
    models: {},
    commitMessage: { agent: 'claude' },
    autoFix: true,
    modeDefaults: { plan: [], build: [] },
    pipelineFallbacks: []
  }
}

/** Drop rungs Farol cannot honour: unknown providers and duplicates. */
export function sanitizeModeChain(raw: unknown): ModelChoice[] {
  if (!Array.isArray(raw)) return []
  const out: ModelChoice[] = []
  const seen = new Set<string>()
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const { agent, model } = row as { agent?: unknown; model?: unknown }
    if (!isAiProvider(agent)) continue
    const id = normalizeModel(model)
    const key = `${agent}:${id ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ agent, ...(id ? { model: id } : {}) })
  }
  return out
}

export function withModeChain(
  settings: AppSettings,
  mode: AgentMode,
  chain: readonly ModelChoice[]
): AppSettings {
  return {
    ...settings,
    modeDefaults: { ...settings.modeDefaults, [mode]: sanitizeModeChain(chain) }
  }
}

/** What a chat in `mode` opens with — the chain's first rung, else the plain default. */
export function modeDefault(settings: AppSettings, mode: AgentMode): ModelChoice {
  const head = settings.modeDefaults[mode][0]
  if (head) return head
  const model = settings.models[settings.agent]
  return { agent: settings.agent, ...(model ? { model } : {}) }
}

/**
 * Provider/model a live pane should use when switching to `mode` — chain head when
 * configured, otherwise keep the pane's current selection. Used by the Plan|Build
 * switch and by Execute plan (which must land on Build the same way).
 */
export function modeSelectionForPane(
  settings: AppSettings,
  mode: AgentMode,
  pane: { provider: AiProvider; model?: string }
): { mode: AgentMode; provider: AiProvider; model?: string } {
  const head = settings.modeDefaults[mode][0]
  const provider = head?.agent ?? pane.provider
  const model = head ? head.model : pane.model
  return { mode: normalizeMode(mode), provider, model }
}

/**
 * Rungs still worth trying after `agent`/`model` failed. A pick the chain does
 * not contain has consumed none of it, so the whole chain stays available;
 * a mode with no chain configured never falls back.
 */
export function modeFallbacks(
  settings: AppSettings,
  mode: AgentMode,
  agent: AiProvider,
  model?: string
): ModelChoice[] {
  const chain = settings.modeDefaults[mode]
  const id = normalizeModel(model)
  const at = chain.findIndex((rung) => rung.agent === agent && normalizeModel(rung.model) === id)
  return chain.slice(at + 1)
}

/**
 * Every pipeline fallback except the step's own model, in chain order. A step
 * pins its own model, so its position in the chain says nothing about what to try.
 */
export function pipelineModelFallbacks(
  settings: AppSettings,
  agent: AiProvider,
  model?: string
): ModelChoice[] {
  const id = normalizeModel(model)
  return settings.pipelineFallbacks.filter(
    (rung) => !(rung.agent === agent && normalizeModel(rung.model) === id)
  )
}

export function withPipelineChain(settings: AppSettings, chain: readonly ModelChoice[]): AppSettings {
  return { ...settings, pipelineFallbacks: sanitizeModeChain(chain) }
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

/** Change the dedicated commit-message generator without touching chat defaults. */
export function withCommitMessageModel(
  settings: AppSettings,
  agent: AiProvider,
  model?: string
): AppSettings {
  const id = normalizeModel(model)
  return { ...settings, commitMessage: { agent, ...(id ? { model: id } : {}) } }
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
  const catalog = sanitizeCatalog(o.catalog)
  // Older settings could pin ids before a catalog was fetched. Keep those ids
  // as well, so a saved selection survives a temporary catalog outage.
  const pinned = uniqueIds(o.pinned)
  const autoPinned = o.autoPinned === true
  const agent = normalizeOpenRouterAgent(o.agent)
  if (!pinned.length && !catalog.length && !autoPinned && agent === 'opencode') return undefined
  return { pinned, catalog, autoPinned, ...(agent === 'opencode' ? {} : { agent }) }
}

/** Jev is on exactly when a key is stored, so the flag is the whole setting. */
export function withJevKeyFlag(settings: AppSettings, hasKey: boolean): AppSettings {
  if (hasKey) return { ...settings, jev: { hasKey } }
  if (!settings.jev) return settings
  const next = { ...settings }
  delete next.jev
  return next
}

/** Pick the CLI OpenRouter runs through; OpenCode is stored as absence. */
export function withOpenRouterAgent(settings: AppSettings, agent: OpenRouterAgent): AppSettings {
  const next: OpenRouterSettings = { ...defaultOpenRouter(), ...settings.openrouter }
  if (agent === 'opencode') delete next.agent
  else next.agent = agent
  return { ...settings, openrouter: next }
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

function sanitizeModeDefaults(raw: unknown): ModeDefaults {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return { plan: sanitizeModeChain(o.plan), build: sanitizeModeChain(o.build) }
}

function isDiscoverableProvider(value: string): value is DiscoverableProvider {
  return (DISCOVERABLE_PROVIDERS as readonly string[]).includes(value)
}

function sanitizeCatalogs(raw: unknown): AgentCatalogs | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: AgentCatalogs = {}
  for (const [provider, value] of Object.entries(raw)) {
    if (!isDiscoverableProvider(provider)) continue
    const catalog = sanitizeCatalog(value)
    if (catalog.length) out[provider] = catalog
  }
  return Object.keys(out).length ? out : undefined
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
  const commitRaw = s.commitMessage
  const hasCommitMessage = !!commitRaw && typeof commitRaw === 'object'
  const commit = hasCommitMessage ? (commitRaw as Record<string, unknown>) : {}
  const commitAgent = isAiProvider(commit.agent) ? commit.agent : agent
  // Installs that predate the dedicated commit-message field inherit the chat
  // model once; after that, an absent model means "use the CLI's own default"
  // (same convention as `models`), even if the user cleared it deliberately.
  const commitModel = normalizeModel(commit.model) ?? (hasCommitMessage ? undefined : models[commitAgent])
  const openrouter = sanitizeOpenRouter(s.openrouter)
  const catalogs = sanitizeCatalogs(s.catalogs)
  return {
    agent,
    models,
    commitMessage: {
      agent: commitAgent,
      ...(commitModel ? { model: commitModel } : {})
    },
    autoFix: typeof s.autoFix === 'boolean' ? s.autoFix : d.autoFix,
    modeDefaults: sanitizeModeDefaults(s.modeDefaults),
    pipelineFallbacks: sanitizeModeChain(s.pipelineFallbacks),
    ...(openrouter ? { openrouter } : {}),
    ...(catalogs ? { catalogs } : {})
  }
}

/**
 * Renderer saves never own live CLI catalogs — only `refreshAgentCatalogs`
 * writes them. A stale in-memory list must not overwrite a just-fetched one.
 */
export function retainCatalogs(incoming: AppSettings, persisted: AppSettings): AppSettings {
  if (persisted.catalogs) return { ...incoming, catalogs: persisted.catalogs }
  if (!incoming.catalogs) return incoming
  const next = { ...incoming }
  delete next.catalogs
  return next
}
