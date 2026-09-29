import type { SettingsResult } from '../shared/types'
import { checkoutSnapshot } from './checkout-snapshot'
import { snapshotSummary } from '../shared/remote'
import { sanitizeRemote } from '../shared/settings'
import { clearSecret, peekSecret, setSecret } from './secrets'
import { loadSettings, saveSettings } from './store'

/** A sandbox on the Farol service holding one checkout snapshot. */
export interface RemoteWorkspace {
  /** What was uploaded, e.g. `12 files, 0.4 MB`. */
  summary: string
  /** Run a shell step; resolves with its exit code. Output arrives with `\r\n` line ends. */
  exec(cmd: string, onChunk: (chunk: string) => void): Promise<number>
  /** Stop the sandbox. Safe to call more than once. */
  close(): Promise<void>
}

export type OpenRemote = (cwd: string, signal: AbortSignal) => Promise<RemoteWorkspace>

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

type Connection = { url: string; key: string }

async function connection(): Promise<Connection> {
  const { remote } = await loadSettings()
  const key = peekSecret('remoteApiKey')
  if (!remote || !key) throw new Error('Remote service is not configured. Add its URL and API key in Settings.')
  return { url: remote.url, key }
}

async function serviceCall({ url, key }: Connection, path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(new URL(path, url), { ...init, headers: { ...init.headers, Authorization: `Bearer ${key}` } })
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
  return {
    summary: snapshotSummary(count, archive.length),
    close: async () => {
      closed ??= serviceCall(service, `/v1/workspaces/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(30_000) }).catch(
        () => undefined
      )
      await closed
    },
    async exec(cmd, onChunk) {
      return readExec(await serviceCall(service, `/v1/workspaces/${id}/exec`, { method: 'POST', body: cmd, signal }), onChunk)
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
  if (!secret && !peekSecret('remoteApiKey')) return result('Paste an API key for the service.')
  try {
    if (secret) setSecret('remoteApiKey', secret)
  } catch (err) {
    return result(message(err))
  }
  await saveSettings({ ...(await loadSettings()), remote })
  return result()
}

export async function clearRemoteConfig(): Promise<SettingsResult> {
  clearSecret('remoteApiKey')
  const settings = await loadSettings()
  delete settings.remote
  await saveSettings(settings)
  return result()
}

/** Call an authenticated endpoint; no error means the URL and key work. */
export async function checkRemote(): Promise<SettingsResult> {
  try {
    await serviceCall(await connection(), '/v1/ping', { method: 'GET', signal: AbortSignal.timeout(15_000) })
    return result()
  } catch (err) {
    return result(message(err))
  }
}
