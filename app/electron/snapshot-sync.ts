import { packSnapshot, type SnapshotPlan } from './checkout-snapshot'
import type { SnapshotManifest } from './snapshot-manifest'

const PIPELINES_FILE = '.farol/pipelines.json'

/** A reply the service refused, with its status so callers can tell "old service" from "bad upload". */
export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export type ServiceCall = (path: string, init: { method: 'POST'; body?: Uint8Array | string; headers?: Record<string, string> }) => Promise<Response>

export interface SyncedSnapshot {
  /** The manifest id a workspace is created from. */
  id: string
  /** Compressed bytes actually uploaded; 0 when the service already held everything. */
  uploadedBytes: number
}

/**
 * Make the service hold every file of `manifest`, sending only what it lacks.
 * Returns null when the service predates content-addressed snapshots, so the
 * caller falls back to uploading the whole archive.
 */
export async function syncSnapshot(
  call: ServiceCall,
  cwd: string,
  plan: SnapshotPlan,
  manifest: SnapshotManifest
): Promise<SyncedSnapshot | null> {
  let created: Response
  try {
    created = await call('/v1/snapshots', {
      method: 'POST',
      body: JSON.stringify({ entries: manifest.entries }),
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (err) {
    if (err instanceof ServiceError && err.status === 404) return null
    throw err
  }
  const { id, missing } = (await created.json()) as { id: string; missing: string[] }
  if (missing.length === 0) return { id, uploadedBytes: 0 }

  const wanted = missing.map((sha) => manifest.pathBySha.get(sha)).filter((p): p is string => p !== undefined)
  // The pipelines file may come from the primary checkout rather than this one.
  const fromRoot = plan.pipelinesRoot !== null && wanted.includes(PIPELINES_FILE)
  const archive = await packSnapshot(
    cwd,
    plan.pipelinesRoot ? wanted.filter((p) => p !== PIPELINES_FILE) : wanted,
    fromRoot ? plan.pipelinesRoot : null
  )
  await call(`/v1/snapshots/${id}/files`, { method: 'POST', body: new Uint8Array(archive) })
  return { id, uploadedBytes: archive.length }
}
