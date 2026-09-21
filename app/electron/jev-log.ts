/**
 * Persist Jev decision records as NDJSON under Electron userData.
 * Failures here must never affect selection or verdicts.
 */

import { createNdjsonLog } from './ndjson-log'

const log = createNdjsonLog({ tag: '[farol] Jev', fileName: 'jev.jsonl', level: 'info' })

/** Wire from main once `app` is ready. Untested paths stay console-only. */
export const configureJevLogs = log.configure
export const jevLogPath = log.path
export const logJev = log.write