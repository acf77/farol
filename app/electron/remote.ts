import type { SettingsResult } from '../shared/types'
import { checkoutSnapshot } from './checkout-snapshot'
import { snapshotSummary } from '../shared/remote'
import { sanitizeVercel } from '../shared/settings'
import { createSandbox, openSandbox, type RemoteWorkspace, type SandboxCredentials } from './sandbox'
import { clearSecret, peekSecret, setSecret } from './secrets'
import { loadSettings, saveSettings } from './store'

export type { RemoteWorkspace }

export type OpenRemote = (cwd: string, signal: AbortSignal) => Promise<RemoteWorkspace>

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function credentials(): Promise<SandboxCredentials> {
  const { vercel } = await loadSettings()
  const token = peekSecret('vercelSandboxToken')
  if (!vercel || !token) {
    throw new Error('Vercel Sandbox is not configured. Add the token, team id and project id in Settings.')
  }
  return { token, teamId: vercel.teamId, projectId: vercel.projectId }
}

export const openVercelWorkspace: OpenRemote = async (cwd, signal) => {
  const { archive, count } = await checkoutSnapshot(cwd)
  const workspace = await openSandbox(await credentials(), archive, snapshotSummary(count, archive.length), signal)
  return {
    ...workspace,
    exec: (cmd, onChunk) => workspace.exec(cmd, (chunk) => onChunk(chunk.replace(/\r?\n/g, '\r\n')))
  }
}

async function result(error?: string): Promise<SettingsResult> {
  return { settings: await loadSettings(), ...(error ? { error } : {}) }
}

export async function saveVercelConfig(raw: unknown): Promise<SettingsResult> {
  const { token, teamId, projectId } = (raw ?? {}) as Record<string, unknown>
  const vercel = sanitizeVercel({ teamId, projectId })
  const secret = typeof token === 'string' ? token.trim() : ''
  if (!vercel) return result('Enter both the Vercel team id and project id.')
  if (!secret && !peekSecret('vercelSandboxToken')) return result('Paste a Vercel access token.')
  try {
    if (secret) setSecret('vercelSandboxToken', secret)
  } catch (err) {
    return result(message(err))
  }
  await saveSettings({ ...(await loadSettings()), vercel })
  return result()
}

export async function clearVercelConfig(): Promise<SettingsResult> {
  clearSecret('vercelSandboxToken')
  const settings = await loadSettings()
  delete settings.vercel
  await saveSettings(settings)
  return result()
}

/** Create and stop a throwaway sandbox; no error means the credentials work. */
export async function checkVercel(): Promise<SettingsResult> {
  try {
    const sandbox = await createSandbox(await credentials(), AbortSignal.timeout(60_000))
    await sandbox.stop()
    return result()
  } catch (err) {
    return result(message(err))
  }
}
