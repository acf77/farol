/** Machine-scoped preferences — which agent to hand work to, and when. */

import { isAiProvider, type AiProvider } from './ai'

export interface AppSettings {
  /** The CLI that failed pipeline steps get handed to. */
  agent: AiProvider
  /** Hand a failure straight to the agent instead of waiting to be asked. */
  autoFix: boolean
}

export function defaultSettings(): AppSettings {
  return { agent: 'claude', autoFix: true }
}

export function sanitizeSettings(raw: unknown): AppSettings {
  const d = defaultSettings()
  if (!raw || typeof raw !== 'object') return d
  const s = raw as Record<string, unknown>
  return {
    agent: isAiProvider(s.agent) ? s.agent : d.agent,
    autoFix: typeof s.autoFix === 'boolean' ? s.autoFix : d.autoFix
  }
}
