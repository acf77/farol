import { execFileSync } from 'child_process'
import fs from 'fs'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteWorkspace } from '../electron/sandbox'
import { createHandler } from './http'
import { createKey } from './keys'
import { RunRegistry } from './runs'

const step = (id: string, type: 'shell' | 'ai', cmd: string) => ({ id, name: id, type, cmd, after: [], x: 0, y: 0 })

/** A gzipped tar of a project whose `.farol/pipelines.json` holds `pipelines`. */
function snapshot(pipelines: unknown[]): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-snap-'))
  fs.mkdirSync(path.join(dir, '.farol'))
  fs.writeFileSync(path.join(dir, '.farol', 'pipelines.json'), JSON.stringify(pipelines))
  const archive = path.join(os.tmpdir(), `${path.basename(dir)}.tgz`)
  execFileSync('tar', ['-czf', archive, '-C', dir, '.'])
  return fs.readFileSync(archive)
}

const workspace: RemoteWorkspace = {
  summary: '',
  close: vi.fn().mockResolvedValue(undefined),
  exec: vi.fn(async (_cmd: string, onChunk: (chunk: string) => void) => {
    onChunk('all good\n')
    return 0
  })
}

let server: Server
let base: string
let key: string
let other: string

beforeEach(async () => {
  const keysFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'farol-http-')), 'keys.json')
  key = createKey(keysFile, 'web').key
  other = createKey(keysFile, 'other').key
  const registry = new RunRegistry(async () => workspace, { maxActive: 1, retentionMs: 60_000 })
  server = createServer(createHandler({ keysFile, registry, snapshotLimit: 1024 * 1024, allowedOrigins: [] }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())))

const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  fetch(base + path, { ...init, headers: { Authorization: `Bearer ${init.token ?? key}`, ...init.headers } })

const startRun = (pipelines: unknown[], pipeline = 'ci') =>
  call('/v1/runs', { method: 'POST', body: new Uint8Array(snapshot(pipelines)), headers: { 'X-Farol-Pipeline': pipeline } })

describe('run service', () => {
  it('requires an API key', async () => {
    expect((await call('/v1/runs/abc', { token: 'nope' })).status).toBe(401)
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
  })

  it('runs a snapshot and streams events to the end', async () => {
    const started = await startRun([{ id: 'ci', name: 'CI', nodes: [step('a', 'shell', 'npm test')] }])
    expect(started.status).toBe(202)
    const { runId } = (await started.json()) as { runId: string }

    const events = await (await call(`/v1/runs/${runId}/events`)).text()
    expect(events).toContain('event: output')
    expect(events).toContain('all good')
    expect(events).toContain('event: end')

    const status = (await (await call(`/v1/runs/${runId}`)).json()) as { status: string; result: { ok: boolean } }
    expect(status).toMatchObject({ status: 'passed', result: { ok: true } })
    expect(workspace.close).toHaveBeenCalled()
  })

  it('keeps runs private to the key that started them', async () => {
    const { runId } = (await (await startRun([{ id: 'ci', name: 'CI', nodes: [step('a', 'shell', 'x')] }])).json()) as {
      runId: string
    }
    expect((await call(`/v1/runs/${runId}`, { token: other })).status).toBe(404)
  })

  it('refuses pipelines with AI steps and unknown pipelines', async () => {
    const ai = await startRun([{ id: 'ci', name: 'CI', nodes: [step('a', 'ai', 'review')] }])
    expect(ai.status).toBe(422)
    expect(await ai.json()).toMatchObject({ aiSteps: ['a'] })
    expect((await startRun([{ id: 'ci', name: 'CI', nodes: [step('a', 'shell', 'x')] }], 'nope')).status).toBe(404)
  })

  it('rejects an upload with no pipelines file', async () => {
    const res = await call('/v1/runs', { method: 'POST', body: 'not a tarball', headers: { 'X-Farol-Pipeline': 'ci' } })
    expect(res.status).toBe(422)
  })
})
