/**
 * Persist provider-failure records (rate limits, exit errors, exhausted
 * fallback chains) as NDJSON under Electron userData, so "why did this chat
 * fall back three times" has a paper trail instead of a scrollback search.
 */

import fs from 'fs'
import path from 'path'

const TAG = '[farol] Agent'

let userDataDir: (() => string) | undefined

/** Wire from main once `app` is ready. Untested paths stay console-only. */
export function configureAgentFailureLogs(dir: () => string): void {
  userDataDir = dir
}

export function agentFailureLogPath(): string | undefined {
  const root = userDataDir?.()
  return root ? path.join(root, 'logs', 'agent-failures.jsonl') : undefined
}

/** Console + append one NDJSON line. Never throws. */
export function logAgentFailure(entry: Record<string, unknown>): void {
  console.warn(TAG, entry)
  const file = agentFailureLogPath()
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    /* swallow — diagnostics must not break the agent cycle */
  }
}
