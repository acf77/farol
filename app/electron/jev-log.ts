/**
 * Persist Jev decision records as NDJSON under Electron userData.
 * Failures here must never affect selection or verdicts.
 */

import fs from 'fs'
import path from 'path'

const TAG = '[farol] Jev'

let userDataDir: (() => string) | undefined

/** Wire from main once `app` is ready. Untested paths stay console-only. */
export function configureJevLogs(dir: () => string): void {
  userDataDir = dir
}

export function jevLogPath(): string | undefined {
  const root = userDataDir?.()
  return root ? path.join(root, 'logs', 'jev.jsonl') : undefined
}

/** Console + append one NDJSON line. Never throws. */
export function logJev(entry: Record<string, unknown>): void {
  console.info(TAG, entry)
  const file = jevLogPath()
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    /* swallow — diagnostics must not break Farol decisions */
  }
}
