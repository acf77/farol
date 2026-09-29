import type { IncomingMessage, RequestListener, ServerResponse } from 'http'
import { resolvePipeline, validateRunnable } from '../shared/graph'
import type { Pipeline } from '../shared/types'
import { verifyKey, type ApiKeyRecord } from './keys'
import { aiStepNames, type ServiceEvent } from './run'
import { BusyError, type RunRecord, type RunRegistry } from './runs'
import { pipelinesFromArchive, readBody, TooLargeError } from './snapshot'
import type { WorkspaceRegistry } from './workspaces'

export interface ServiceDeps {
  keysFile: string
  registry: RunRegistry
  workspaces: WorkspaceRegistry
  /** Largest accepted snapshot upload, in bytes. */
  snapshotLimit: number
  /** Browser origins allowed to call the API. */
  allowedOrigins: string[]
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {}
  ) {
    super(message)
  }
}

interface Context {
  deps: ServiceDeps
  req: IncomingMessage
  res: ServerResponse
  key: ApiKeyRecord
  /** Capture groups from the route pattern. */
  params: string[]
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

function corsHeaders(deps: ServiceDeps, req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin
  if (!origin || !deps.allowedOrigins.includes(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Farol-Pipeline, Last-Event-ID',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    Vary: 'Origin'
  }
}

function findRun({ deps, key, params }: Context): RunRecord {
  const record = deps.registry.get(params[0], key.id)
  if (!record) throw new HttpError(404, 'Run not found')
  return record
}

/** The pipeline named by the request, read from the `.farol/pipelines.json` inside the upload. */
function requestedPipeline(pipelines: Pipeline[], query: string): Pipeline {
  const found = resolvePipeline(pipelines, query)
  if (!found.ok) throw new HttpError(404, found.message, { candidates: found.candidates })
  const invalid = validateRunnable(found.pipeline.nodes)
  if (invalid) throw new HttpError(422, invalid)
  const aiSteps = aiStepNames(found.pipeline)
  if (aiSteps.length) {
    throw new HttpError(422, 'Pipelines with AI steps cannot run on the service', { aiSteps })
  }
  return found.pipeline
}

async function readArchive({ deps, req }: Context): Promise<Buffer> {
  try {
    const archive = await readBody(req, deps.snapshotLimit)
    if (!archive.length) throw new HttpError(400, 'Send the project snapshot (a .tar.gz) as the request body')
    return archive
  } catch (error) {
    throw error instanceof TooLargeError ? new HttpError(413, error.message) : error
  }
}

/** Turn a full-pool error into 429 with a retry hint; rethrow anything else. */
function busy(error: unknown): never {
  if (error instanceof BusyError) throw new HttpError(429, error.message, {}, { 'Retry-After': '30' })
  throw error
}

const EXEC_COMMAND_LIMIT = 256 * 1024

async function createWorkspace(ctx: Context): Promise<void> {
  const archive = await readArchive(ctx)
  const abort = new AbortController()
  ctx.req.on('close', () => abort.abort())
  const id = await ctx.deps.workspaces.create(ctx.key.id, archive, abort.signal).catch(busy)
  json(ctx.res, 201, { id })
}

function findWorkspace({ deps, key, params }: Context) {
  const workspace = deps.workspaces.get(params[0], key.id)
  if (!workspace) throw new HttpError(404, 'Workspace not found')
  return workspace
}

/** Run one command; the reply is NDJSON — `{chunk}` lines, then a single `{code}` line. */
async function execInWorkspace(ctx: Context): Promise<void> {
  const workspace = findWorkspace(ctx)
  const cmd = (await readBody(ctx.req, EXEC_COMMAND_LIMIT).catch((error: unknown) => {
    throw error instanceof TooLargeError ? new HttpError(413, 'Command is too large') : error
  })).toString('utf8')
  if (!cmd.trim()) throw new HttpError(400, 'Send the command as the request body')
  ctx.res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' })
  const send = (event: { chunk: string } | { code: number }): void => void ctx.res.write(`${JSON.stringify(event)}\n`)
  try {
    send({ code: await workspace.exec(cmd, (chunk) => send({ chunk })) })
  } catch (error) {
    send({ chunk: `farol: ${error instanceof Error ? error.message : String(error)}\n` })
    send({ code: 127 })
  }
  ctx.res.end()
}

async function closeWorkspace(ctx: Context): Promise<void> {
  if (!(await ctx.deps.workspaces.close(ctx.params[0], ctx.key.id))) throw new HttpError(404, 'Workspace not found')
  ctx.res.writeHead(204).end()
}

async function createRun(ctx: Context): Promise<void> {
  const query = ctx.req.headers['x-farol-pipeline']
  if (typeof query !== 'string' || !query.trim()) throw new HttpError(400, 'Set the X-Farol-Pipeline header')
  const archive = await readArchive(ctx)
  const pipelines = await pipelinesFromArchive(archive).catch((error: Error) => {
    throw new HttpError(422, error.message)
  })
  const pipeline = requestedPipeline(pipelines, query)
  const record = (() => {
    try {
      return ctx.deps.registry.start(ctx.key.id, pipeline, archive)
    } catch (error) {
      return busy(error)
    }
  })()
  json(ctx.res, 202, { runId: record.id, status: record.status, pipelineId: record.pipelineId })
}

function showRun(ctx: Context): void {
  const { id, pipelineId, pipelineName, status, createdAt, finishedAt, summary } = findRun(ctx)
  json(ctx.res, 200, {
    id,
    pipelineId,
    pipelineName,
    status,
    createdAt,
    finishedAt,
    ...(summary ? { result: summary } : {})
  })
}

function cancelRun(ctx: Context): void {
  const record = findRun(ctx)
  ctx.deps.registry.cancel(record.id)
  json(ctx.res, record.finishedAt ? 200 : 202, { runId: record.id, status: record.status })
}

function streamRun(ctx: Context): void {
  const { req, res, deps } = ctx
  const record = findRun(ctx)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no'
  })
  const send = (index: number, event: ServiceEvent): void => {
    res.write(`id: ${index}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  const resumeAt = Number(req.headers['last-event-id']) + 1 || 0
  for (const { id, event } of record.events) {
    if (id >= resumeAt) send(id, event)
  }
  const unsubscribe = record.finishedAt ? null : deps.registry.subscribe(record.id, (index, event) => {
    send(index, event)
    if (event.type === 'end') stop()
  })
  const beat = setInterval(() => res.write(': ping\n\n'), 15_000)
  const stop = (): void => {
    clearInterval(beat)
    unsubscribe?.()
    res.end()
  }
  req.on('close', stop)
  if (!unsubscribe) stop()
}

const routes: { method: string; pattern: RegExp; handler: (ctx: Context) => Promise<void> | void }[] = [
  { method: 'GET', pattern: /^\/v1\/ping$/, handler: (ctx) => json(ctx.res, 200, { ok: true }) },
  { method: 'POST', pattern: /^\/v1\/workspaces$/, handler: createWorkspace },
  { method: 'POST', pattern: /^\/v1\/workspaces\/([0-9a-f]+)\/exec$/, handler: execInWorkspace },
  { method: 'DELETE', pattern: /^\/v1\/workspaces\/([0-9a-f]+)$/, handler: closeWorkspace },
  { method: 'POST', pattern: /^\/v1\/runs$/, handler: createRun },
  { method: 'GET', pattern: /^\/v1\/runs\/([0-9a-f]+)$/, handler: showRun },
  { method: 'GET', pattern: /^\/v1\/runs\/([0-9a-f]+)\/events$/, handler: streamRun },
  { method: 'POST', pattern: /^\/v1\/runs\/([0-9a-f]+)\/cancel$/, handler: cancelRun }
]

async function dispatch(deps: ServiceDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET' && pathname === '/healthz') return json(res, 200, { ok: true })
  const key = verifyKey(deps.keysFile, bearer(req))
  if (!key) throw new HttpError(401, 'Missing or invalid API key', {}, { 'WWW-Authenticate': 'Bearer' })
  for (const { method, pattern, handler } of routes) {
    const match = pattern.exec(pathname)
    if (match && req.method === method) return handler({ deps, req, res, key, params: match.slice(1) })
  }
  throw new HttpError(404, 'Not found')
}

export function createHandler(deps: ServiceDeps): RequestListener {
  return (req, res) => {
    const cors = corsHeaders(deps, req)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }
    for (const [name, value] of Object.entries(cors)) res.setHeader(name, value)
    dispatch(deps, req, res).catch((error: unknown) => {
      if (res.headersSent) return void res.end()
      if (error instanceof HttpError) {
        return json(res, error.status, { error: error.message, ...error.extra }, error.headers)
      }
      console.error(error)
      json(res, 500, { error: 'Internal error' })
    })
  }
}
