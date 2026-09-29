/**
 * The CLI OpenRouter runs through, mirrored from settings so spawn sites can
 * read it synchronously. `store.ts` refreshes it on every settings load/save.
 */

import type { OpenRouterAgent } from '../shared/ai'

let current: OpenRouterAgent = 'opencode'

export function openRouterAgent(): OpenRouterAgent {
  return current
}

export function setOpenRouterAgent(agent: OpenRouterAgent): void {
  current = agent
}
