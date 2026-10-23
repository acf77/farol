/**
 * Per-run OpenCode settings, passed in `OPENCODE_CONFIG_CONTENT` so nothing
 * touches the developer's own OpenCode config files.
 *
 * Verified against OpenCode 1.19.4: its `plan` agent is not read-only on its
 * own (it denies `write`/`edit` but runs `bash` freely), and an `ask` rule is
 * approved outright under `--dangerously-skip-permissions`. Only `deny` holds.
 */

import type { AgentMode } from './ai'
import { MANAGED_TOOL_TIMEOUT_SEC } from './mcp-config'

/** The env var OpenCode reads an extra JSON config layer from. */
export const OPENCODE_CONFIG_ENV = 'OPENCODE_CONFIG_CONTENT'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

/** `overlay` laid over `base`, objects merged key by key, everything else replaced. */
function merge(base: Json, overlay: Json): Json {
  const out: Json = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = isObject(value) && isObject(out[key]) ? merge(out[key] as Json, value) : value
  }
  return out
}

/**
 * What Farol needs from OpenCode for one run: Plan's shell denied so Plan
 * stays read-only; with `askFirst`, edits, shell and web fetches set to ask so
 * they reach the developer; and with `managedServer`, MCP calls allowed to
 * wait as long as a `delegate` runs (OpenCode otherwise gives up after about a
 * minute, verified on 1.19.4).
 */
export function opencodeRunConfig(mode: AgentMode, askFirst: boolean, managedServer = false): Json | undefined {
  const parts: Json[] = [
    mode === 'plan' ? { agent: { plan: { permission: { bash: 'deny' } } } } : {},
    mode !== 'plan' && askFirst ? { permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' } } : {},
    managedServer ? { experimental: { mcp_timeout: MANAGED_TOOL_TIMEOUT_SEC * 1000 } } : {}
  ]
  const config = parts.reduce(merge, {})
  return Object.keys(config).length ? config : undefined
}

/**
 * The env value carrying `overlay`, merged over whatever the developer already
 * passes in the same variable; Farol's rules win where they overlap.
 */
export function opencodeConfigContent(existing: string | undefined, overlay: Json): string {
  let base: Json = {}
  if (existing?.trim()) {
    try {
      const parsed: unknown = JSON.parse(existing)
      if (isObject(parsed)) base = parsed
    } catch {
      // Not JSON, so OpenCode could not have used it either.
    }
  }
  return JSON.stringify(merge(base, overlay))
}

/** Lay a command's OpenCode run config (if any) into the env it is spawned with. */
export function applyOpencodeConfig(env: Record<string, string | undefined>, config: Json | undefined): void {
  if (config) env[OPENCODE_CONFIG_ENV] = opencodeConfigContent(env[OPENCODE_CONFIG_ENV], config)
}
