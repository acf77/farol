import { errorMessage } from '../shared/jev'
import type { IncomingMessage, RequestListener, ServerResponse } from 'http'
import { gzipSync } from 'zlib'
import { resolvePipeline, validateRunnable } from '../shared/graph'
import type { Pipeline } from '../shared/types'
import { AccessDenied, identify, loginScope, signIn, type AuthConfig, type Identity, type LoginConfig } from './auth'
import { GitHubError } from './github'
import { aiStepNames, type ServiceEvent } from './run'
import { BusyError, type RunRecord, type RunRegistry } from './runs'
import { pinnedCommands } from './pinned'
import { pipelinesFromArchive, readBody, TooLargeError } from './snapshot'
import { revokeSessions } from './users'
import { CommandRefused, type WorkspaceRegistry } from './workspaces'

export interface ServiceDeps {
  auth: AuthConfig
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
  /** The authenticated caller; it owns the runs and workspaces it starts. */
  owner: Identity
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

function findRun({ deps, owner, params }: Context): RunRecord {
  const record = deps.registry.get(params[0], owner.id)
  if (!record) throw new HttpError(404, 'Run not found')
  return record
}

/** The pipeline named by the request, read from the `.farol/pipelines.json` inside the upload. */
function requestedPipeline(pipelines: Pipeline[], query: string): Pipeline {
  const found = resolvePipeline(pipelines, query)
  if (!found.ok) throw new HttpError(404, found.message, { candidates: found.candidates })
  const invalid = validateRunnable(found.pipeline.nodes)
  if (invalid) throw new HttpError(422, invalid)
  if (found.pipeline.nodes.some((n) => n.type === 'git')) {
    throw new HttpError(422, 'Pipelines with git steps cannot run on the service')
  }
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
  // Pin the snapshot's own pipelines: the workspace runs their shell steps and nothing else.
  const pipelines = await pipelinesFromArchive(archive).catch((error: Error) => {
    throw new HttpError(422, error.message)
  })
  const abort = new AbortController()
  ctx.req.on('close', () => abort.abort())
  const id = await ctx.deps.workspaces.create(ctx.owner.id, archive, pinnedCommands(pipelines), abort.signal).catch(busy)
  json(ctx.res, 201, { id })
}

function requireWorkspace({ deps, owner, params }: Context): string {
  if (!deps.workspaces.owns(params[0], owner.id)) throw new HttpError(404, 'Workspace not found')
  return params[0]
}

/** Run one of the workspace's pinned steps; the reply is NDJSON — `{chunk}` lines, then a single `{code}` line. */
async function execInWorkspace(ctx: Context): Promise<void> {
  const cmd = (await readBody(ctx.req, EXEC_COMMAND_LIMIT).catch((error: unknown) => {
    throw error instanceof TooLargeError ? new HttpError(413, 'Command is too large') : error
  })).toString('utf8')
  if (!cmd.trim()) throw new HttpError(400, 'Send the command as the request body')
  const id = requireWorkspace(ctx)
  // Headers wait for the first line, so a refused command can still answer 403.
  const send = (event: { chunk: string } | { code: number }): void => {
    if (!ctx.res.headersSent) ctx.res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' })
    ctx.res.write(`${JSON.stringify(event)}\n`)
  }
  try {
    send({ code: await ctx.deps.workspaces.exec(id, cmd, (chunk) => send({ chunk })) })
  } catch (error) {
    if (error instanceof CommandRefused) throw new HttpError(403, error.message)
    send({ chunk: `farol: ${errorMessage(error)}\n` })
    send({ code: 127 })
  }
  ctx.res.end()
}

async function closeWorkspace(ctx: Context): Promise<void> {
  if (!(await ctx.deps.workspaces.close(ctx.params[0], ctx.owner.id))) throw new HttpError(404, 'Workspace not found')
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
  try {
    const record = ctx.deps.registry.start(ctx.owner.id, pipeline, archive)
    json(ctx.res, 202, { runId: record.id, status: record.result.status, pipelineId: record.result.pipeline.id })
  } catch (error) {
    busy(error)
  }
}

/** The run's JSON result (`shared/run-result.ts`), gzipped when the client accepts it. */
function showRun(ctx: Context): void {
  const body = Buffer.from(JSON.stringify(findRun(ctx).result))
  const gzip = /\bgzip\b/.test(String(ctx.req.headers['accept-encoding'] ?? '')) && body.length > 1024
  ctx.res.writeHead(200, {
    'Content-Type': 'application/json',
    Vary: 'Accept-Encoding',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {})
  })
  ctx.res.end(gzip ? gzipSync(body) : body)
}

function cancelRun(ctx: Context): void {
  const record = findRun(ctx)
  ctx.deps.registry.cancel(record.id)
  json(ctx.res, record.result.finishedAt ? 200 : 202, { runId: record.id, status: record.result.status })
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
  const unsubscribe = record.result.finishedAt ? null : deps.registry.subscribe(record.id, (index, event) => {
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

const AUTH_BODY_LIMIT = 16 * 1024

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await readBody(req, AUTH_BODY_LIMIT).catch(() => {
    throw new HttpError(413, 'Request body is too large')
  })).toString('utf8')
  try {
    const parsed: unknown = JSON.parse(text || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new HttpError(400, 'Send a JSON object')
}

function requireLogin(deps: ServiceDeps): LoginConfig {
  if (!deps.auth.login) throw new HttpError(404, 'GitHub sign-in is not configured on this service')
  return deps.auth.login
}

function stringField(body: Record<string, unknown>, name: string, required = true): string | undefined {
  const value = body[name]
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (required) throw new HttpError(400, `Missing ${name}`)
  return undefined
}

/** Map sign-in failures to responses: refused users get 403, GitHub trouble 502. */
async function signInWith(login: LoginConfig, githubToken: Promise<string>): ReturnType<typeof signIn> {
  try {
    return await signIn(login, await githubToken)
  } catch (error) {
    if (error instanceof AccessDenied) throw new HttpError(403, error.message)
    if (error instanceof GitHubError) throw new HttpError(502, error.message)
    throw error
  }
}

/** Device flow, step 1: the client shows `userCode` and opens `verificationUri`. */
async function startDeviceLogin(deps: ServiceDeps, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const login = requireLogin(deps)
  try {
    json(res, 200, await login.github.startDevice(loginScope(login)))
  } catch (error) {
    if (error instanceof GitHubError) throw new HttpError(502, error.message)
    throw error
  }
}

/** Device flow, step 2: poll every `interval` seconds until the user approves. */
async function pollDeviceLogin(deps: ServiceDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const login = requireLogin(deps)
  const deviceCode = stringField(await readJson(req), 'deviceCode') as string
  const poll = await login.github.pollDevice(deviceCode).catch((error: unknown) => {
    throw error instanceof GitHubError ? new HttpError(502, error.message) : error
  })
  if (poll.status === 'pending') return json(res, 200, { status: 'pending', ...(poll.interval ? { interval: poll.interval } : {}) })
  if (poll.status !== 'ok') throw new HttpError(400, poll.status === 'denied' ? 'Sign-in was denied' : 'The device code expired; start again')
  json(res, 200, { status: 'ok', ...(await signInWith(login, Promise.resolve(poll.token))) })
}

/** Browser flow (web and mobile): exchange the code GitHub redirected back with. */
async function codeLogin(deps: ServiceDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const login = requireLogin(deps)
  const body = await readJson(req)
  const code = stringField(body, 'code') as string
  const redirectUri = stringField(body, 'redirectUri') as string
  const codeVerifier = stringField(body, 'codeVerifier', false)
  const refusal = login.github.codeFlowRefusal(redirectUri)
  if (refusal) throw new HttpError(400, refusal)
  json(res, 200, await signInWith(login, login.github.exchangeCode(code, redirectUri, codeVerifier)))
}

const signInRoutes: { method: string; path: string; handler: (deps: ServiceDeps, req: IncomingMessage, res: ServerResponse) => Promise<void> }[] = [
  { method: 'POST', path: '/v1/auth/device', handler: startDeviceLogin },
  { method: 'POST', path: '/v1/auth/device/token', handler: pollDeviceLogin },
  { method: 'POST', path: '/v1/auth/code', handler: codeLogin }
]

function showMe({ res, owner }: Context): void {
  const { id, kind, name, displayName, avatarUrl } = owner
  json(res, 200, { id, kind, name, ...(displayName ? { displayName } : {}), ...(avatarUrl ? { avatarUrl } : {}) })
}

/** Sign the user out everywhere: every session they hold stops working. */
function logout({ deps, res, owner }: Context): void {
  if (owner.githubId === undefined) throw new HttpError(400, 'API keys are revoked with `keys revoke`, not signed out')
  revokeSessions(requireLogin(deps).usersFile, owner.githubId)
  res.writeHead(204).end()
}

const routes: { method: string; pattern: RegExp; handler: (ctx: Context) => Promise<void> | void }[] = [
  { method: 'GET', pattern: /^\/v1\/ping$/, handler: (ctx) => json(ctx.res, 200, { ok: true }) },
  { method: 'GET', pattern: /^\/v1\/me$/, handler: showMe },
  { method: 'POST', pattern: /^\/v1\/auth\/logout$/, handler: logout },
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
  const signInRoute = signInRoutes.find((r) => r.method === req.method && r.path === pathname)
  if (signInRoute) return signInRoute.handler(deps, req, res)
  const owner = identify(deps.auth, bearer(req))
  if (!owner) throw new HttpError(401, 'Missing, invalid or expired token', {}, { 'WWW-Authenticate': 'Bearer' })
  for (const { method, pattern, handler } of routes) {
    const match = pattern.exec(pathname)
    if (match && req.method === method) return handler({ deps, req, res, owner, params: match.slice(1) })
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
