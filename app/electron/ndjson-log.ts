/**
 * Append diagnostics as NDJSON under Electron userData. Console output plus one
 * file line; never throws, so logging cannot affect the caller's decisions.
 */

import fs from 'fs'
import path from 'path'

export interface NdjsonLog {
  configure: (dir: () => string) => void
  path: () => string | undefined
  write: (entry: Record<string, unknown>) => void
}

export function createNdjsonLog(opts: {
  tag: string
  fileName: string
  level: 'info' | 'warn'
}): NdjsonLog {
  let userDataDir: (() => string) | undefined
  const pathTo = (): string | undefined => {
    const root = userDataDir?.()
    return root ? path.join(root, 'logs', opts.fileName) : undefined
  }
  const write = (entry: Record<string, unknown>): void => {
    console[opts.level](opts.tag, entry)
    const file = pathTo()
    if (!file) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      /* swallow — diagnostics must not break the caller */
    }
  }
  return {
    configure: (dir) => {
      userDataDir = dir
    },
    path: pathTo,
    write
  }
}