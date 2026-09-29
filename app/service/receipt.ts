import { createHash } from 'crypto'
import type { RequestListener } from 'http'
import { snapshotSummary } from '../shared/remote'
import { readBody, TooLargeError } from './snapshot'

/**
 * Credential-free mode: accepts a checkout tar and reports what arrived. It runs
 * nothing, so it never reports a pipeline result.
 */
export function createReceiptHandler(limit: number): RequestListener {
  const send = (res: Parameters<RequestListener>[1], status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  return async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true, mode: 'receipt' })
    if (req.method !== 'POST' || pathname !== '/v1/receipts') return send(res, 404, { error: 'Not found' })
    try {
      const archive = await readBody(req, limit)
      const sha256 = createHash('sha256').update(archive).digest('hex')
      console.log(`receipt ${sha256.slice(0, 12)} ${snapshotSummary(0, archive.length)}`)
      send(res, 200, { ok: true, bytes: archive.length, sha256, executed: false })
    } catch (error) {
      if (error instanceof TooLargeError) return send(res, 413, { error: error.message })
      console.error(error)
      send(res, 500, { error: 'Internal error' })
    }
  }
}
