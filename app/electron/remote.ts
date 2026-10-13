import { errorMessage } from '../shared/jev'
import { shell } from 'electron'
import type { RemoteAccount, RemoteSignInStart } from '../shared/types'
import { checkoutSnapshot, snapshotPlan } from './checkout-snapshot'
import { buildManifest } from './snapshot-manifest'
import { ServiceError, syncSnapshot, type SyncedSnapshot } from './snapshot-sync'
import { SIGN_IN_REQUIRED, snapshotSummary, syncSummary } from '../shared/remote'
import type { RemoteWorkspace } from './sandbox'
import { clearSecret, peekSecret, setSecret } from './secrets'
import { SERVICE_URL } from './service-url'
import { clearBillingLinks, notePaymentRequired } from './billing-links'

export type { RemoteWorkspace }

export type OpenRemote = (cwd: string, signal: AbortSignal) => Promise<RemoteWorkspace>

/** The user is not signed in, or the service no longer accepts their session. Not worth retrying. */
export class SignInRequired extends Error {
  constructor() {
    super(SIGN_IN_REQUIRED)
  }
}

/** The service wants payment before this run or workspace: 402. Retrying cannot help. */
export class PaymentRequired extends ServiceError {
  constructor(message: string) {
    super(message, 402)
  }
}

/** The session token for the built-in service; throws SignInRequired when there is none. */
export function session(): string {
  const token = peekSecret('remoteSession')
  if (!token) throw new SignInRequired()
  return token
}

export async function serviceCall(path: string, init: RequestInit & { token?: string }): Promise<Response> {
  const { token, ...rest } = init
  const res = await fetch(new URL(path, SERVICE_URL), {
    ...rest,
    headers: { ...rest.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  })
  if (res.status === 401) {
    // The session expired or was revoked: forget it so the account menu offers Sign in.
    if (token && peekSecret('remoteSession') === token) clearSecret('remoteSession')
    clearBillingLinks()
    throw new SignInRequired()
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; upgradeUrl?: string }
    if (res.status === 402) {
      notePaymentRequired(body.upgradeUrl)
      throw new PaymentRequired(body.error ?? 'Upgrade to keep running remote pipelines.')
    }
    throw new ServiceError(body.error ?? `Remote service replied HTTP ${res.status}`, res.status)
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

type Prepared = { plan: Awaited<ReturnType<typeof snapshotPlan>>; manifest: Awaited<ReturnType<typeof buildManifest>> }

/**
 * One run, one snapshot plan: the start-up retries share the run's abort signal, so
 * they reuse the hashed manifest instead of walking the checkout again. Keying on
 * the signal (not the directory) means a later run always sees the files as they are then.
 */
const preparedByRun = new WeakMap<AbortSignal, Promise<Prepared>>()

function prepare(cwd: string, signal: AbortSignal, fresh = false): Promise<Prepared> {
  let prepared = fresh ? undefined : preparedByRun.get(signal)
  if (!prepared) {
    prepared = snapshotPlan(cwd).then(async (plan) => ({ plan, manifest: await buildManifest(cwd, plan) }))
    // A failed plan is not worth keeping: let the next attempt try again.
    prepared.catch(() => preparedByRun.delete(signal))
    preparedByRun.set(signal, prepared)
  }
  return prepared
}

/** Send the service what it lacks. A file edited while packing, or an evicted blob, gets one fresh try. */
async function syncWithRetry(cwd: string, signal: AbortSignal, token: string): Promise<{ synced: SyncedSnapshot; files: number } | null> {
  const call = (path: string, init: Parameters<typeof serviceCall>[1]) => serviceCall(path, { ...init, signal, token })
  for (let attempt = 0; ; attempt++) {
    const { plan, manifest } = await prepare(cwd, signal, attempt > 0)
    try {
      const synced = await syncSnapshot(call, cwd, plan, manifest)
      return synced && { synced, files: manifest.entries.length }
    } catch (err) {
      if (attempt === 0 && err instanceof ServiceError && (err.status === 422 || err.status === 409)) continue
      throw err
    }
  }
}

/** Create the workspace from a synced snapshot; if its files were evicted meanwhile, sync once more. */
async function createWorkspace(cwd: string, signal: AbortSignal, token: string): Promise<{ id: string; summary: string }> {
  for (let attempt = 0; ; attempt++) {
    const synced = await syncWithRetry(cwd, signal, token)
    if (!synced) {
      // An older service: upload the whole archive, as before.
      const { archive, count } = await checkoutSnapshot(cwd)
      const created = await serviceCall('/v1/workspaces', { method: 'POST', body: new Uint8Array(archive), signal, token })
      return { id: ((await created.json()) as { id: string }).id, summary: snapshotSummary(count, archive.length) }
    }
    try {
      const created = await serviceCall('/v1/workspaces', {
        method: 'POST',
        headers: { 'X-Farol-Snapshot': synced.synced.id },
        signal,
        token
      })
      return { id: ((await created.json()) as { id: string }).id, summary: syncSummary(synced.files, synced.synced.uploadedBytes) }
    } catch (err) {
      if (attempt === 0 && err instanceof ServiceError && err.status === 409) continue
      throw err
    }
  }
}

export const openRemote: OpenRemote = async (cwd, signal) => {
  const token = session()
  const { id, summary } = await createWorkspace(cwd, signal, token)
  let closed: Promise<unknown> | undefined
  // One command at a time: parallel commands on a single sandbox are unreliable.
  let queue: Promise<unknown> = Promise.resolve()
  return {
    summary,
    close: async () => {
      closed ??= serviceCall(`/v1/workspaces/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(30_000), token }).catch(
        () => undefined
      )
      await closed
    },
    exec(cmd, onChunk) {
      const run = async (): Promise<number> =>
        readExec(await serviceCall(`/v1/workspaces/${id}/exec`, { method: 'POST', body: cmd, signal, token }), onChunk)
      const result = queue.then(run, run)
      queue = result.catch(() => undefined)
      return result
    }
  }
}

/** Forget this machine's session. */
export function signOutRemote(): void {
  clearSecret('remoteSession')
  clearBillingLinks()
}

const AVATAR_HOST = 'avatars.githubusercontent.com'
const AVATAR_LIMIT = 512 * 1024
const avatars = new Map<string, string>()

/** A GitHub avatar as a `data:` URL, or undefined. Only GitHub's avatar host is fetched. */
async function avatarData(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined
  const cached = avatars.get(url)
  if (cached) return cached
  try {
    const src = new URL(url)
    if (src.protocol !== 'https:' || src.hostname !== AVATAR_HOST) return undefined
    src.searchParams.set('s', '64')
    const res = await fetch(src, { signal: AbortSignal.timeout(10_000) })
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) return undefined
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > AVATAR_LIMIT) return undefined
    const data = `data:${type};base64,${bytes.toString('base64')}`
    avatars.set(url, data)
    return data
  } catch {
    return undefined
  }
}

/** Who the stored session belongs to. A session the service rejects reads as signed out. */
export async function remoteAccount(): Promise<RemoteAccount> {
  try {
    const res = await serviceCall('/v1/me', { signal: AbortSignal.timeout(15_000), token: session() })
    const me = (await res.json()) as { name?: string; displayName?: string; avatarUrl?: string }
    const avatar = await avatarData(me.avatarUrl)
    return {
      state: 'signedIn',
      login: me.name ?? '',
      ...(me.displayName ? { displayName: me.displayName } : {}),
      ...(avatar ? { avatar } : {})
    }
  } catch (err) {
    if (err instanceof SignInRequired) return { state: 'signedOut' }
    return { state: 'error', message: 'Cannot reach the remote service. Check your connection and try again.' }
  }
}

/** The device-flow sign-in in progress; a new start or a cancel aborts it. */
let pendingSignIn: { deviceCode: string; interval: number; expiresAt: number; abort: AbortController } | undefined

/** Device flow, step 1: get a code from the service and open GitHub's approval page in the browser. */
export async function startRemoteSignIn(): Promise<RemoteSignInStart> {
  cancelRemoteSignIn()
  try {
    const res = await serviceCall('/v1/auth/device', { method: 'POST', signal: AbortSignal.timeout(15_000) })
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

/** Device flow, step 2: poll until the user approves, then keep the session in the encrypted store. */
export async function waitRemoteSignIn(): Promise<{ error?: string }> {
  const pending = pendingSignIn
  if (!pending) return { error: 'Start signing in first.' }
  const { signal } = pending.abort
  try {
    let interval = pending.interval
    while (Date.now() < pending.expiresAt) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, interval * 1000)
        signal.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('Sign-in cancelled.'))), { once: true })
      })
      const res = await serviceCall('/v1/auth/device/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: pending.deviceCode }),
        signal
      })
      const poll = (await res.json()) as { status: string; interval?: number; token?: string }
      if (poll.status === 'pending') {
        interval = poll.interval ?? interval
        continue
      }
      if (!poll.token) throw new Error('The service did not return a session.')
      setSecret('remoteSession', poll.token)
      return {}
    }
    return { error: 'The sign-in code expired. Start again.' }
  } catch (err) {
    return { error: errorMessage(err) }
  } finally {
    if (pendingSignIn === pending) pendingSignIn = undefined
  }
}
