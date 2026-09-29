import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { afterEach, expect, it } from 'vitest'
import { createReceiptHandler } from './receipt'

let server: Server
afterEach(() => server.close())

async function start(limit: number): Promise<string> {
  server = createServer(createReceiptHandler(limit))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

it('returns size and hash without executing anything', async () => {
  const base = await start(1024)
  const res = await fetch(`${base}/v1/receipts`, { method: 'POST', body: 'abc' })
  expect(await res.json()).toEqual({
    ok: true,
    bytes: 3,
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    executed: false
  })
})

it('rejects oversized uploads', async () => {
  const base = await start(2)
  const res = await fetch(`${base}/v1/receipts`, { method: 'POST', body: 'abc' })
  expect(res.status).toBe(413)
})
