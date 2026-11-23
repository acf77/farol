/** Reading `[surface/]provider[:model][@effort]` into a subject. */

import { AGENT_EFFORTS, isAiProvider, type AgentEffort } from '../shared/ai'
import type { Subject, Surface } from './types'

export function parseSubject(spec: string): Subject {
  const m = /^(?:(chat|mcp)\/)?([a-z-]+)(?::([^@]+))?(?:@(\w+))?$/.exec(spec.trim())
  if (!m) throw new Error(`Cannot read subject "${spec}"; use [chat|mcp/]provider[:model][@effort]`)
  const [, surface = 'chat', provider, model, effort] = m
  if (!isAiProvider(provider)) throw new Error(`Unknown agent CLI "${provider}" in "${spec}"`)
  if (effort && !(AGENT_EFFORTS as readonly string[]).includes(effort)) throw new Error(`Unknown effort "${effort}"; use ${AGENT_EFFORTS.join(', ')}`)
  if (surface === 'mcp' && provider !== 'claude') throw new Error('The mcp surface runs Claude Code only, for now')
  return {
    surface: surface as Surface,
    provider,
    ...(model ? { model } : {}),
    ...(effort ? { effort: effort as AgentEffort } : {}),
    label: `${surface}/${provider}${model ? `:${model}` : ''}${effort ? `@${effort}` : ''}`
  }
}
