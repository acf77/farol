import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildManifest, clearHashCache } from './snapshot-manifest'
import { ServiceError, syncSnapshot, type ServiceCall } from './snapshot-sync'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-sync-'))
  clearHashCache()
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one')
  fs.writeFileSync(path.join(dir, 'b.txt'), 'two')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const plan = { files: ['a.txt', 'b.txt'], pipelinesRoot: null }
const json = (body: unknown) => new Response(JSON.stringify(body))
const listing = (archive: Uint8Array) => execFileSync('tar', ['-tzf', '-'], { input: Buffer.from(archive) }).toString().trim().split('\n')

describe('syncSnapshot', () => {
  it('uploads only the files the service reports missing', async () => {
    const manifest = await buildManifest(dir, plan)
    const bSha = manifest.entries[1].sha!
    const calls: { path: string; body?: unknown }[] = []
    const call: ServiceCall = async (p, init) => {
      calls.push({ path: p, body: init.body })
      return p === '/v1/snapshots' ? json({ id: 'm1', missing: [bSha] }) : json({ stored: 1, missing: [] })
    }
    const synced = await syncSnapshot(call, dir, plan, manifest)
    expect(synced?.id).toBe('m1')
    expect(calls.map((c) => c.path)).toEqual(['/v1/snapshots', '/v1/snapshots/m1/files'])
    expect(listing(calls[1].body as Uint8Array)).toEqual(['b.txt'])
    expect(synced!.uploadedBytes).toBeGreaterThan(0)
  })

  it('uploads nothing when the service holds every file', async () => {
    const manifest = await buildManifest(dir, plan)
    const paths: string[] = []
    const call: ServiceCall = async (p) => {
      paths.push(p)
      return json({ id: 'm2', missing: [] })
    }
    expect(await syncSnapshot(call, dir, plan, manifest)).toEqual({ id: 'm2', uploadedBytes: 0 })
    expect(paths).toEqual(['/v1/snapshots'])
  })

  it('returns null for a service without snapshot endpoints', async () => {
    const manifest = await buildManifest(dir, plan)
    const call: ServiceCall = async () => {
      throw new ServiceError('not found', 404)
    }
    expect(await syncSnapshot(call, dir, plan, manifest)).toBeNull()
  })

  it('passes other service errors through', async () => {
    const manifest = await buildManifest(dir, plan)
    const call: ServiceCall = async () => {
      throw new ServiceError('too big', 422)
    }
    await expect(syncSnapshot(call, dir, plan, manifest)).rejects.toMatchObject({ status: 422 })
  })
})
