/**
 * Persist provider-failure records (rate limits, exit errors, exhausted
 * fallback chains) as NDJSON under Electron userData, so "why did this chat
 * fall back three times" has a paper trail instead of a scrollback search.
 */

import { createNdjsonLog } from './ndjson-log'

const log = createNdjsonLog({
  tag: '[farol] Agent',
  fileName: 'agent-failures.jsonl',
  level: 'warn'
})

/** Wire from main once `app` is ready. Untested paths stay console-only. */
export const configureAgentFailureLogs = log.configure
export const agentFailureLogPath = log.path
export const logAgentFailure = log.write