/**
 * Tokens and cost of a run, from Claude Code's own session transcripts
 * (`~/.claude/projects/<dir>/<session>.jsonl`). Farol's stream parser does not
 * keep the cost, and the transcript is where Claude Code records it: a
 * `cost-state` line whose `totalCostUSD` is cumulative for the session, resumes
 * included. Other CLIs report nothing here yet.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Usage } from './types'

function transcript(session: string): string | undefined {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')
  let dirs: string[]
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return undefined
  }
  for (const dir of dirs) {
    const file = path.join(root, dir, `${session}.jsonl`)
    if (fs.existsSync(file)) return file
  }
  return undefined
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, sessions: [] }
}

export function claudeUsage(sessions: Iterable<string>): Usage {
  const usage = emptyUsage()
  let cost: number | undefined
  for (const session of new Set(sessions)) {
    usage.sessions.push(session)
    const file = transcript(session)
    if (!file) continue
    // A streamed message is written more than once; keep its last usage.
    const messages = new Map<string, Record<string, unknown>>()
    let sessionCost: number | undefined
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (entry.type === 'cost-state' && typeof entry.totalCostUSD === 'number') sessionCost = entry.totalCostUSD
      const message = entry.message as Record<string, unknown> | undefined
      if (entry.type !== 'assistant' || !message || typeof message.usage !== 'object' || !message.usage) continue
      messages.set(String(message.id ?? entry.uuid), message.usage as Record<string, unknown>)
    }
    for (const u of messages.values()) {
      usage.inputTokens += num(u.input_tokens)
      usage.outputTokens += num(u.output_tokens)
      usage.cacheReadTokens += num(u.cache_read_input_tokens)
      usage.cacheWriteTokens += num(u.cache_creation_input_tokens)
    }
    if (sessionCost !== undefined) cost = (cost ?? 0) + sessionCost
  }
  return cost === undefined ? usage : { ...usage, costUsd: cost }
}
