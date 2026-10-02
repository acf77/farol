import { errorMessage } from '../shared/jev'
import { shell } from 'electron'
import type { RemoteResult, RemoteSignInStart, SettingsResult } from '../shared/types'
import { checkoutSnapshot } from './checkout-snapshot'
import { snapshotSummary } from '../shared/remote'
import type { RemoteWorkspace } from './sandbox'
import { sanitizeRemote } from '../shared/settings'
import { clearSecret, peekSecret, setSecret } from './secrets'
import { loadSettings, saveSettings } from './store'

export type { RemoteWorkspace }

export type OpenRemote = (cwd: string, signal: AbortSignal) => Promise<RemoteWorkspace>

type Connection = { url: string; key?: string }

async function connection(): Promise<Connection> {
  const { remote } = await loadSettings()
  if (!remote) throw new Error('Remote service is not configured. Add its URL in Settings.')
  return { url: remote.url, key: peekSecret('remoteApiKey') ?? undefined }
}

async function serviceCall({ url, key }: Connection, path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(new URL(path, url), { ...init, headers: { ...init.headers, ...(key ? { Authorization: `Bearer ${key}` } : {}) } })
  if (res.status === 401) {
    throw new Error(key ? 'The service rejected the stored token. Sign in again.' : 'The service requires sign-in. Sign in with GitHub in Settings.')
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Remote service replied HTTP ${res.status}`)
  }
  return res
}

/** Read the service's NDJSON reply to an exec: `{chunk}` lines, then one `{code}` line. */
async function readExec(res: Response, onChunk: (chunk: string) => void): Promise<number> {
  const decoder = new TextDecoder()
  let pending = ''
  let code: number | undefined
  const take = (line: string): void => {
    if (!line) return
    const event = JSON.parse(line) as { chunk?: string; code?: number }
    if (event.chunk !== undefined) onChunk(event.chunk.replace(/\r?\n/g, '\r\n'))
    if (event.code !== undefined) code = event.code
  }
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(part, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    lines.forEach(take)
  }
  take(pending)
  if (code === undefined) throw new Error('The remote service ended the step without an exit code.')
  return code
}

export const openRemote: OpenRemote = async (cwd, signal) => {
  const { archive, count } = await checkoutSnapshot(cwd)
  const service = await connection()
  const created = await serviceCall(service, '/v1/workspaces', { method: 'POST', body: new Uint8Array(archive), signal })
  const { id } = (await created.json()) as { id: string }
  let closed: Promise<unknown> | undefined
  // One command at a time: parallel commands on a single sandbox are unreliable.
  let queue: Promise<unknown> = Promise.resolve()
  return {
    summary: snapshotSummary(count, archive.length),
    close: async () => {
      closed ??= serviceCall(service, `/v1/workspaces/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(30_000) }).catch(
        () => undefined
      )
      await closed
    },
    exec(cmd, onChunk) {
      const run = async (): Promise<number> =>
        readExec(await serviceCall(service, `/v1/workspaces/${id}/exec`, { method: 'POST', body: cmd, signal }), onChunk)
      const result = queue.then(run, run)
      queue = result.catch(() => undefined)
      return result
    }
  }
}

async function result(error?: string): Promise<SettingsResult> {
  return { settings: await loadSettings(), ...(error ? { error } : {}) }
}

export async function saveRemoteConfig(raw: unknown): Promise<SettingsResult> {
  const { url: rawUrl, key } = (raw ?? {}) as Record<string, unknown>
  const remote = sanitizeRemote({ url: rawUrl })
  const secret = typeof key === 'string' ? key.trim() : ''
  if (!remote) return result('Enter the service URL, starting with http:// or https://.')
  try {
    if (secret) setSecret('remoteApiKey', secret)
  } catch (err) {
    return result(errorMessage(err))
  }
  await saveSettings({ ...(await loadSettings()), remote })
  return result()
}

export async function clearRemoteKey(): Promise<SettingsResult> {
  clearSecret('remoteApiKey')
  return result()
}

/** Ask the service who the stored token belongs to; no error means the URL and token work. */
export async function checkRemote(): Promise<RemoteResult> {
  try {
    const res = await serviceCall(await connection(), '/v1/me', { method: 'GET', signal: AbortSignal.timeout(15_000) })
    const { name } = (await res.json()) as { name?: string }
    return { ...(await result()), ...(name ? { account: name } : {}) }
  } catch (err) {
    return result(errorMessage(err))
  }
}

/** The device-flow sign-in in progress; a new start or a cancel aborts it. */
let pendingSignIn: { deviceCode: string; interval: number; expiresAt: number; abort: AbortController } | undefined

/** Device flow, step 1: get a code from the service and open GitHub's approval page in the browser. */
export async function startRemoteSignIn(): Promise<RemoteSignInStart> {
  cancelRemoteSignIn()
  try {
    const { url } = await connection()
    const res = await serviceCall({ url }, '/v1/auth/device', { method: 'POST', signal: AbortSignal.timeout(15_000) })
    const start = (await res.json()) as { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }
    // Only ever open GitHub, whatever the service sent.
    if (new URL(start.verificationUri).origin !== 'https://github.com') throw new Error('The service sent an unexpected sign-in page.')
    pendingSignIn = {
      deviceCode: start.deviceCode,
      interval: start.interval,
      expiresAt: Date.now() + start.expiresIn * 1000,
      abort: new AbortController()
    }
    await shell.openExternal(start.verificationUri)
    return { userCode: start.userCode, verificationUri: start.verificationUri }
  } catch (err) {
    return { error: errorMessage(err) }
  }
}

export function cancelRemoteSignIn(): void {
  pendingSignIn?.abort.abort()
  pendingSignIn = undefined
}

/** Device flow, step 2: poll until the user approves, then keep the session where the API key goes. */
export async function waitRemoteSignIn(): Promise<RemoteResult> {
  const pending = pendingSignIn
  if (!pending) return result('Start signing in first.')
  const { signal } = pending.abort
  try {
    const { url } = await connection()
    let interval = pending.interval
    while (Date.now() < pending.expiresAt) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, interval * 1000)
        signal.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('Sign-in cancelled.'))), { once: true })
      })
      const res = await serviceCall({ url }, '/v1/auth/device/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: pending.deviceCode }),
        signal
      })
      const poll = (await res.json()) as { status: string; interval?: number; token?: string; user?: { login: string } }
      if (poll.status === 'pending') {
        interval = poll.interval ?? interval
        continue
      }
      if (!poll.token) throw new Error('The service did not return a session.')
      setSecret('remoteApiKey', poll.token)
      return { ...(await result()), ...(poll.user ? { account: poll.user.login } : {}) }
    }
    return result('The sign-in code expired. Start again.')
  } catch (err) {
    return result(errorMessage(err))
  } finally {
    if (pendingSignIn === pending) pendingSignIn = undefined
  }
}
