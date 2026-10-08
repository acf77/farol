import { spawn } from 'child_process'
import type { IncomingMessage } from 'http'
import { sanitizePipelines } from '../shared/graph'
import type { Pipeline } from '../shared/types'

export class TooLargeError extends Error {}

/** Buffer a request body, refusing anything over `limit` bytes. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new TooLargeError(`Snapshot is larger than ${Math.floor(limit / 1024 / 1024)} MB`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Largest `.farol/pipelines.json` read out of an upload; a tiny gzip can expand to far more. */
const PIPELINES_FILE_LIMIT = 1024 * 1024

/** One member of a gzipped tar, or null when the archive has no such member. */
function extractMember(archive: Buffer, member: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzOf', '-', member], { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    tar.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > PIPELINES_FILE_LIMIT) {
        tooLarge = true
        tar.kill()
        return
      }
      chunks.push(chunk)
    })
    tar.on('error', reject)
    tar.on('close', (code) => {
      if (tooLarge) return reject(new Error(`${member} is larger than 1 MB`))
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null)
    })
    tar.stdin.on('error', () => undefined)
    tar.stdin.end(archive)
  })
}

/** The pipelines committed in the uploaded project, from `.farol/pipelines.json`. */
export async function pipelinesFromArchive(archive: Buffer): Promise<Pipeline[]> {
  for (const member of ['.farol/pipelines.json', './.farol/pipelines.json']) {
    const text = await extractMember(archive, member)
    if (text === null) continue
    try {
      return sanitizePipelines(JSON.parse(text)) ?? []
    } catch {
      throw new Error('.farol/pipelines.json is not valid JSON')
    }
  }
  throw new Error('The snapshot has no .farol/pipelines.json')
}
