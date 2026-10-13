import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { SnapshotPlan } from './checkout-snapshot'

const PIPELINES_FILE = '.farol/pipelines.json'

/** One path of a snapshot, as the run service's manifest describes it. */
export interface ManifestEntry {
  path: string
  sha?: string
  size?: number
  mode?: number
  link?: string
}

export interface SnapshotManifest {
  entries: ManifestEntry[]
  /** Uncompressed bytes of every regular file. */
  totalBytes: number
  /** One path per distinct content hash, for packing what the service lacks. */
  pathBySha: Map<string, string>
}

interface Hashed {
  size: number
  mtimeMs: number
  sha: string
}

/** A file whose size and mtime are unchanged is not read again on the next run. */
const hashCache = new Map<string, Hashed>()
const HASH_CONCURRENCY = 32

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

async function cachedHash(file: string, size: number, mtimeMs: number): Promise<string> {
  const hit = hashCache.get(file)
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.sha
  const sha = await hashFile(file)
  hashCache.set(file, { size, mtimeMs, sha })
  return sha
}

/** Forget cached hashes; for tests, and for a caller that suspects a stale cache. */
export function clearHashCache(): void {
  hashCache.clear()
}

/**
 * Describe the planned snapshot by content hash. Files that vanish or cannot be
 * read are left out, as the packed archive leaves them out too.
 */
export async function buildManifest(cwd: string, plan: SnapshotPlan): Promise<SnapshotManifest> {
  const sources: { rel: string; abs: string }[] = plan.files.map((rel) => ({ rel, abs: path.join(cwd, rel) }))
  if (plan.pipelinesRoot) sources.push({ rel: PIPELINES_FILE, abs: path.join(plan.pipelinesRoot, PIPELINES_FILE) })

  const slots: (ManifestEntry | null)[] = new Array(sources.length).fill(null)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < sources.length; i = next++) {
      const { rel, abs } = sources[i]
      try {
        const stat = fs.lstatSync(abs)
        if (stat.isSymbolicLink()) {
          slots[i] = { path: rel, link: fs.readlinkSync(abs) }
        } else if (stat.isFile()) {
          slots[i] = { path: rel, sha: await cachedHash(abs, stat.size, stat.mtimeMs), size: stat.size, mode: stat.mode & 0o777 }
        }
      } catch {
        /* gone or unreadable: skipped */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, sources.length) }, worker))

  const entries = slots.filter((entry): entry is ManifestEntry => entry !== null)
  const pathBySha = new Map<string, string>()
  let totalBytes = 0
  for (const entry of entries) {
    if (!entry.sha) continue
    totalBytes += entry.size ?? 0
    if (!pathBySha.has(entry.sha)) pathBySha.set(entry.sha, entry.path)
  }
  return { entries, totalBytes, pathBySha }
}
