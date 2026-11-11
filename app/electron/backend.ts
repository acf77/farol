import { scanAgents } from './agent-scan'
import path from 'path'
import fs from 'fs'
import type {
  AgentTaskRequest,
  AppSettings,
  GitHookEvent,
  MergeStrategy,
  Pipeline,
  Project,
  ProjectWriteOpts,
  RunEvent,
  ShellCwd,
  ShellActivity,
  ShellData,
  ShellExit,
  WorktreeRequest
} from '../shared/types'
import { ShellManager } from './shell'
import { HeadWatcher, addWorktree, bringPrConflicts, checkout, commitAll, draftCommit, draftPullRequest, githubStatus, hooksInfo, info as gitInfo, pipelineStoreRootFor, pull as gitPull, push as gitPush, recentCommits, status as gitStatus, syncManagedHooks } from './git'
import { createPullRequest, mergePullRequest } from './github'
import { PipelineRunner } from './runner'
import { loadPipelines, pushRecent, readRecents, savePipelines, toProject, lastProjectPath, loadOpenProjects, saveOpenProjects, loadProjectSession, saveProjectSession, clearLastProject, loadSettings, PipelineWatcher } from './store'
import { refreshAgentCatalogs } from './agent-models'
import { errorMessage } from '../shared/jev'
import { listProjectDir, listProjectFiles, readProjectFile, saveChatAttachment, writeProjectFile } from './files'
import { listAgentSkills } from './skills'
import { openRouterAgent } from './openrouter-agent'
import { providerUsage } from './usage'
import {
  MANAGED_MCP_TOOLS,
  managedMcpEntry,
  TOKEN_ENV,
  mergeMcpConfig,
  MCP_CONFIG_REL_PATHS,
  type McpServerEntry
} from '../shared/mcp-config'
import { codexHookCommand } from '../shared/codex-hook'
import type { ProjectSession } from '../shared/session'
import { pruneTrees } from './delegate-snapshot'
import { pruneCheckpoints } from './checkpoints'
import { BRIDGE_ENV, socketPathFor, takeLines, type BridgeReply, type BridgeRequest } from '../shared/bridge'
import { isAiProvider, normalizeEffort } from '../shared/ai'
import { resolvePipeline, topoSort, validateRunnable } from '../shared/graph'
import { appendTail, plainText } from '../shared/terminal'
import { AgentController } from './agent-controller'
import { createTodoStore } from './todos'
import { createCustomPromptStore } from './custom-prompts'
import { mergeTodos, parseTodos } from '../shared/todos'
import { closedProjects } from '../shared/session'
import { owningWorktree } from '../shared/worktree'
import { scopedRuntimeId } from '../shared/runtime'
import net from 'net'
import { randomBytes } from 'crypto'
import os from 'os'
import { ProcRegistry } from './proc-sessions'
import { listPorts, ProcSampler } from './proc-sampler'
import { ProcCleanup } from './proc-cleanup'
import { redact, type ProcSnapshot } from '../shared/proc'
import { sanitizeSettings } from '../shared/settings'

/**
 * Everything that works on projects: files, git, shells, pipelines, agents.
 *
 * It runs in one of two places. In the desktop app it runs inside Electron's
 * main process, answering the renderer over IPC. On a **Remote machine** it
 * runs headless under plain Node (`server.ts`), and the desktop app forwards
 * the same channels to it over SSH. `BackendHost` is all it needs from where
 * it runs, so neither side keeps a second copy of these handlers.
 */
export interface BackendHost {
  /** Register a request handler. The first argument is the caller (IPC event, or nothing). */
  handle(channel: string, fn: (event: unknown, ...args: any[]) => unknown): void
  /** Push an event to every client. */
  send(channel: string, payload: unknown): void
  /** Where per-machine app data (todos, prompts) is kept. */
  userData(): string
  /** Absolute path of one of Farol's own Node scripts (`mcp.js`, `git-hook.js`, `codex-hook.js`). */
  scriptPath(file: string): string
  /** The macOS memory helper; anywhere else it is skipped. */
  procsnapPath(): string
  /** Whether someone is looking, so memory sampling can slow down when not. */
  isVisible(): boolean
}

let host: BackendHost
const send = (channel: string, payload: unknown): void => host?.send(channel, payload)

/** Every request channel the backend answers. The desktop app forwards these to a Remote machine. */
export const BACKEND_CHANNEL_PREFIXES = [
  'project:',
  'session:',
  'todos:',
  'pipelines:',
  'shell:',
  'git:',
  'run:',
  'agent:',
  'proc:',
  'prompts:',
  'agents:',
  'agentModels:',
  'usage:'
] as const

/** True for a channel (request or event) the backend owns. */
export function isBackendChannel(channel: string): boolean {
  return BACKEND_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix))
}

let memoryLimits = { warnGb: 2, alertGb: 4 }
const rememberMemoryLimits = (s: AppSettings): void => {
  memoryLimits = { warnGb: s.memoryWarnGb, alertGb: s.memoryAlertGb }
}
const withLimits = (snapshot: ProcSnapshot): ProcSnapshot => ({ ...redact(snapshot), ...memoryLimits })

const procCleanup = new ProcCleanup({
  sample: () => procSampler.sample(),
  sessions: () => procs.list(),
  autoCleanEnabled: async () => (await loadSettings()).autoCleanLeftovers,
  uid: process.getuid?.() ?? -1
})
const procs = new ProcRegistry((session) => procCleanup.schedule(session))
const procSampler = new ProcSampler({
  registry: procs,
  get helperPath() {
    return host.procsnapPath()
  },
  isVisible: () => host.isVisible(),
  onSnapshot: (snapshot) => send('proc:snapshot', withLimits(snapshot)),
  worktreeExists: (dir) => fs.existsSync(dir),
  onWorktreeGone: (sessionId) => procCleanup.runAuto(sessionId),
  uid: process.getuid?.() ?? -1
})

const shells = new ShellManager(
  (e: ShellData) => send('shell:data', e),
  (e: ShellExit) => send('shell:exit', e),
  (e: ShellCwd) => send('shell:cwd', e),
  (e: ShellActivity) => send('shell:activity', e),
  procs
)
const runner = new PipelineRunner((e: RunEvent) => {
  send('run:event', e)
  for (const run of agentRuns) run.onEvent(e)
})
const todos = createTodoStore(
  () => host.userData(),
  (event) => send('todos:changed', event)
)
const prompts = createCustomPromptStore(() => host.userData(), pipelineStoreRootFor)
const agents = new AgentController(
  runner,
  (event) => send('agent:event', event),
  undefined,
  todos,
  prompts,
  loadPipelines,
  MANAGED_MCP_TOOLS.length
    ? {
        mcp: (taskId, delegateId, tools) => managedMcpEntry(managedScript('mcp.js'), taskId, delegateId, tools),
        codexHook: (taskId, delegateId) => codexHookCommand(managedMcpEntry(managedScript('codex-hook.js'), taskId, delegateId))
      }
    : undefined,
  procs
)
const head = new HeadWatcher(async (cwd) =>
  send('git:changed', { projectPath: cwd, info: await gitInfo(cwd) })
)
const pipelineFiles = new PipelineWatcher((projectPath, pipelines) => {
  send('pipelines:changed', { projectPath, pipelines })
  void syncProjectGitHooks(projectPath, projectPath, pipelines)
})

/**
 * Point agents at this project's pipelines by declaring Farol's MCP server
 * in each supported client's project config (`.mcp.json`, `.cursor/mcp.json`).
 * Run through Electron with ELECTRON_RUN_AS_NODE so there is no dependency on a
 * `node` binary — `process.execPath` is the same Electron in development and in
 * the packaged app.
 */
/**
 * Runs an agent asked for, tracked until their `end` event so the MCP server
 * can be told what happened. They go through the app's own runner, so the run
 * tab, streaming log, and sidebar status behave as if a person clicked Run.
 */
interface AgentRun {
  onEvent: (e: RunEvent) => void
}
const agentRuns = new Set<AgentRun>()

const AGENT_RUN_TIMEOUT_MS = 15 * 60 * 1000
const AGENT_STEP_OUTPUT_LIMIT = 4000

function agentStepLabel(skipped: boolean | undefined, ok: boolean): string {
  if (skipped) return 'SKIP'
  return ok ? 'PASS' : 'FAIL'
}

function agentRunOutcomeLabel(cancelled: boolean | undefined, ok: boolean): string {
  if (cancelled) return 'CANCELLED'
  return ok ? 'PASSED' : 'FAILED'
}

function formatAgentRunReport(
  pipelineName: string,
  branch: string,
  nodes: { id: string; name: string }[],
  status: Map<string, { label: string; code: number }>,
  output: Map<string, string>,
  cancelled: boolean | undefined,
  ok: boolean
): string {
  const lines = [`${agentRunOutcomeLabel(cancelled, ok)}: ${pipelineName} on ${branch}`, '']
  for (const n of nodes) {
    const st = status.get(n.id) ?? { label: 'SKIP', code: 0 }
    const exit = st.label === 'FAIL' ? ` (exit ${st.code})` : ''
    lines.push(`[${st.label}] ${n.name || n.id}${exit}`)
  }
  for (const n of nodes) {
    if (status.get(n.id)?.label !== 'FAIL') continue
    const text = (output.get(n.id) ?? '').trim().slice(-AGENT_STEP_OUTPUT_LIMIT)
    if (text) lines.push('', `--- output: ${n.name || n.id} ---`, text)
  }
  return lines.join('\n')
}

function runForAgent(
  pipeline: Pipeline,
  cwd: string,
  branch: string,
  projectPath: string
): Promise<{ text: string; failed: boolean }> {
  return new Promise((resolve) => {
    const runtimePipeline = {
      ...pipeline,
      // Keep MCP runs off the UI `pipeline:` slot so a user Run and an agent
      // `run_pipeline` of the same definition cannot join or orphan each other.
      id: scopedRuntimeId(projectPath, `mcp-pipeline:${pipeline.id}`)
    }
    const nodes = topoSort(pipeline.nodes) ?? []
    const invalid = validateRunnable(pipeline.nodes)
    if (invalid || !nodes.length) {
      resolve({
        text: `FAILED: ${pipeline.name} — ${invalid || 'empty pipeline'}`,
        failed: true
      })
      return
    }
    const output = new Map<string, string>()
    const status = new Map<string, { label: string; code: number }>()
    let settled = false

    const finish = (text: string, failed: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      agentRuns.delete(run)
      resolve({ text, failed })
    }

    const run: AgentRun = {
      onEvent: (e) => {
        if (e.pipelineId !== runtimePipeline.id || e.origin !== 'agent') return
        if (e.kind === 'output') {
          output.set(
            e.nodeId,
            appendTail(output.get(e.nodeId) ?? '', plainText(e.chunk), AGENT_STEP_OUTPUT_LIMIT)
          )
          return
        }
        if (e.kind === 'step-end') {
          status.set(e.nodeId, { label: agentStepLabel(e.skipped, e.ok), code: e.code })
          return
        }
        if (e.kind === 'end') {
          finish(
            formatAgentRunReport(pipeline.name, branch, nodes, status, output, e.cancelled, e.ok),
            !e.ok
          )
        }
      }
    }
    agentRuns.add(run)

    const timer = setTimeout(() => {
      runner.cancel(runtimePipeline.id)
      finish(`TIMED OUT after 15 minutes: ${pipeline.name}`, true)
    }, AGENT_RUN_TIMEOUT_MS)

    runner.start(runtimePipeline, cwd, branch, 'agent')
  })
}

/** True when `cwd` is the open project or one of its linked worktrees. */
async function cwdAllowedForProject(projectPath: string, cwd: string): Promise<boolean> {
  const abs = path.resolve(cwd)
  const root = path.resolve(projectPath)
  if (abs === root || abs.startsWith(root + path.sep)) return true
  const git = await gitInfo(projectPath)
  for (const wt of git.worktrees ?? []) {
    const base = path.resolve(wt.path)
    if (abs === base || abs.startsWith(base + path.sep)) return true
  }
  return false
}

/** Commit/push only run in a project the app currently has open. */
async function openProjectCwd(
  projectPath: unknown
): Promise<{ path: string } | { ok: false; error: string }> {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    return { ok: false, error: 'Invalid project path' }
  }
  const { paths } = await loadOpenProjects()
  const resolved = path.resolve(projectPath).replace(/[/\\]+$/, '')
  const match = paths.find((p) => path.resolve(p).replace(/[/\\]+$/, '') === resolved)
  if (!match) return { ok: false, error: 'Not an open project' }
  return { path: path.resolve(match) }
}

/** Run every pipeline configured for `event`, stopping at the first failure like a shell `&&` chain. */
async function runHookPipelines(
  req: { id: number; cwd: string },
  event: GitHookEvent,
  pipelines: Pipeline[],
  projectPath: string
): Promise<BridgeReply> {
  const matches = pipelines.filter((p) => p.gitHooks?.includes(event))
  if (!matches.length) return { id: req.id, ok: true, op: 'hook', text: '', failed: false }
  const git = await gitInfo(req.cwd)
  const branch = git.branch || '(no branch)'
  const parts: string[] = []
  let failed = false
  for (const pipeline of matches) {
    const result = await runForAgent(pipeline, req.cwd, branch, projectPath)
    parts.push(result.text)
    failed = result.failed
    if (failed) break
  }
  return { id: req.id, ok: true, op: 'hook', text: parts.join('\n\n'), failed }
}

async function handleBridge(
  req: Exclude<BridgeRequest, { op: 'delegate' | 'approve' }>,
  projectPath: string
): Promise<BridgeReply> {
  if (!(await cwdAllowedForProject(projectPath, req.cwd))) {
    return {
      id: req.id,
      ok: false,
      message: `cwd is outside this project: ${req.cwd}`
    }
  }
  // The agent's own directory wins, so an agent in a worktree runs that worktree.
  const pipelines = await loadPipelines(req.cwd)
  if (req.op === 'list') {
    return {
      id: req.id,
      ok: true,
      op: 'list',
      pipelines: pipelines.map((p) => ({
        id: p.id,
        name: p.name,
        steps: (topoSort(p.nodes) ?? p.nodes).map((n) => `${n.name || n.id} (${n.type})`)
      }))
    }
  }
  if (req.op === 'hook') {
    return runHookPipelines(req, req.event, pipelines, projectPath)
  }
  const found = resolvePipeline(pipelines, req.pipeline)
  if (!found.ok) {
    const detail = found.candidates.length ? `\nAvailable:\n- ${found.candidates.join('\n- ')}` : ''
    return { id: req.id, ok: false, message: found.message + detail }
  }
  const git = await gitInfo(req.cwd)
  const { text, failed } = await runForAgent(
    found.pipeline,
    req.cwd,
    git.branch || '(no branch)',
    projectPath
  )
  return { id: req.id, ok: true, op: 'run', text, failed }
}

const bridges = new Map<string, net.Server>()

/**
 * Serve NDJSON bridge requests on `file`. `signal` aborts when the asking
 * socket closes, so a caller that goes away (an agent killed mid-call) does
 * not leave its work running.
 */
function listenBridge(
  file: string,
  handle: (req: BridgeRequest, signal: AbortSignal) => Promise<BridgeReply>
): net.Server {
  bridges.get(file)?.close()
  bridges.delete(file)
  try {
    fs.rmSync(file, { force: true })
  } catch {
    /* nothing to clear */
  }
  const server = net.createServer((socket) => {
    let buffer = ''
    const BRIDGE_BUFFER_LIMIT = 256 * 1024
    const gone = new AbortController()
    socket.on('close', () => gone.abort())
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.length > BRIDGE_BUFFER_LIMIT) {
        socket.destroy()
        return
      }
      const { lines, rest } = takeLines(buffer)
      buffer = rest
      for (const line of lines) {
        let req: BridgeRequest
        try {
          req = JSON.parse(line) as BridgeRequest
        } catch {
          continue
        }
        void handle(req, gone.signal)
          .then((reply) => socket.write(JSON.stringify(reply) + '\n'))
          .catch((err) =>
            socket.write(
              JSON.stringify({
                id: req.id,
                ok: false,
                message: errorMessage(err)
              }) + '\n'
            )
          )
      }
    })
    socket.on('error', () => socket.destroy())
  })
  // Losing the race for the socket is fine: agents fall back to running headless.
  server.on('error', () => undefined)
  server.on('close', () => {
    if (bridges.get(file) === server) bridges.delete(file)
  })
  server.listen(file)
  bridges.set(file, server)
  return server
}

/**
 * Drop subagent snapshots for chats that are gone: neither saved in the
 * project's session nor held by the app. Best effort; a project that is not a
 * git checkout has none.
 */
async function pruneDelegateSnapshots(projectPath: string, session: ProjectSession | null): Promise<void> {
  const saved = (session?.tabs ?? []).flatMap((tab) =>
    tab.panes.flatMap((pane) => (pane.kind === 'agent' ? [pane.taskId] : []))
  )
  const keep = [...saved, ...agents.taskIds()]
  await pruneTrees(projectPath, keep).catch(() => undefined)
  await pruneCheckpoints(projectPath, keep).catch(() => undefined)
}

function startBridge(projectPath: string): void {
  listenBridge(socketPath(projectPath), async (req) =>
    req.op === 'delegate' || req.op === 'approve'
      ? { id: req.id, ok: false, message: `${req.op} is only available in managed Chat.` }
      : handleBridge(req, projectPath)
  )
}

/**
 * Managed Chat's own socket, one for the whole app: its requests name a task,
 * not a project, and the controller already knows each task's checkout.
 */
const managedSocket = path.join(os.tmpdir(), `farol-chat-${process.pid}.sock`)
const managedToken = randomBytes(24).toString('hex')

function startManagedBridge(): void {
  listenBridge(managedSocket, async (req, signal) => {
    if (req.op !== 'delegate' && req.op !== 'approve') {
      return { id: req.id, ok: false, message: 'Only managed Chat tools are served here.' }
    }
    if (req.token !== managedToken) return { id: req.id, ok: false, message: 'Not authorized.' }
    if (req.op === 'approve') {
      const answer = await agents.requestApproval(
        req.taskId,
        { toolName: req.toolName, input: req.input, ...(req.delegateId ? { delegateId: req.delegateId } : {}) },
        signal
      )
      return { id: req.id, ok: true, op: 'approve', ...answer }
    }
    const result = await agents.delegate(
      req.taskId,
      { provider: req.provider, model: req.model, task: req.task, context: req.context },
      signal
    )
    return result.ok
      ? { id: req.id, ok: true, op: 'delegate', text: result.text, failed: result.failed }
      : { id: req.id, ok: false, message: result.message }
  })
}

function socketPath(projectPath: string): string {
  return socketPathFor(projectPath, os.tmpdir(), path.sep)
}

/** One of Farol's own scripts, run as plain Node through the app's own Electron. */
function mcpScript(file = 'mcp.js'): McpServerEntry {
  return {
    command: process.execPath,
    args: [host.scriptPath(file)],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
}

/** A script managed Chat starts, pointed at the managed socket. */
function managedScript(file: string): McpServerEntry {
  const script = mcpScript(file)
  return { ...script, env: { ...script.env, [BRIDGE_ENV]: managedSocket, [TOKEN_ENV]: managedToken } }
}

function mcpEntry(projectPath: string): McpServerEntry {
  const script = mcpScript()
  return { ...script, env: { ...script.env, [BRIDGE_ENV]: socketPath(projectPath) } }
}

/**
 * Brings `.git/hooks` in line with which pipelines have `gitHooks` set, for
 * the project whose app instance serves `socketFor`'s bridge (see
 * `installMcpConfig` for why those two paths can differ, e.g. a worktree).
 */
async function syncProjectGitHooks(dir: string, socketFor = dir, pipelines?: Pipeline[]): Promise<void> {
  const list = pipelines ?? (await loadPipelines(dir))
  await syncManagedHooks(dir, list, {
    execPath: process.execPath,
    scriptPath: host.scriptPath('git-hook.js'),
    socketPath: socketPath(socketFor)
  })
}

/**
 * `dir` is where project-local configs are written; `socketFor` is the project
 * whose app instance serves the bridge. They differ for a worktree: its agents
 * talk to the app that owns the main checkout, and pass their own cwd with each
 * request.
 *
 * Also merges into `~/.cursor/mcp.json`. Cursor's CLI (and often the IDE agent)
 * ignores project `.cursor/mcp.json`; the user-level file is what they load.
 * Last opened project wins for the shared `farol` key.
 */
function installMcpConfig(dir: string, socketFor = dir): void {
  const entry = mcpEntry(socketFor)
  const files = [
    ...MCP_CONFIG_REL_PATHS.map((rel) => path.join(dir, ...rel.split('/'))),
    path.join(os.homedir(), '.cursor', 'mcp.json')
  ]
  for (const file of files) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      const next = mergeMcpConfig(existing, entry)
      if (next !== null) fs.writeFileSync(file, next, 'utf8')
    } catch {
      /* a read-only or unusual project is not a reason to fail the open */
    }
  }
}

function registerProjectIpc(): void {
  host.handle('project:openPath', (_e, dir: string) => openProjectAt(dir))
  host.handle('project:recents', () => readRecents())
  host.handle('project:listFiles', (_e, projectPath: string, query?: string) =>
    listProjectFiles(projectPath, typeof query === 'string' ? query : '')
  )
  host.handle('project:listDir', (_e, projectPath: string, relDir?: string) =>
    typeof projectPath === 'string'
      ? listProjectDir(projectPath, typeof relDir === 'string' ? relDir : '')
      : { ok: false, error: 'Path is outside the project.' }
  )
  host.handle('project:readFile', (_e, projectPath: string, relPath: string) =>
    typeof projectPath === 'string' && typeof relPath === 'string'
      ? readProjectFile(projectPath, relPath)
      : { ok: false, error: 'Path is outside the project.' }
  )
  host.handle(
    'project:writeFile',
    (_e, projectPath: string, relPath: string, content: string, opts?: ProjectWriteOpts) =>
      typeof projectPath === 'string' && typeof relPath === 'string' && typeof content === 'string'
        ? writeProjectFile(projectPath, relPath, content, opts ?? {})
        : { ok: false, error: 'Path is outside the project.' }
  )
  host.handle('project:listSkills', (_e, projectPath: string, provider: unknown) =>
    typeof projectPath === 'string' && isAiProvider(provider)
      ? listAgentSkills(projectPath, provider, undefined, openRouterAgent())
      : []
  )
  host.handle(
    'project:saveAttachment',
    (_e, projectPath: string, name: string, data: ArrayBuffer) => {
      if (typeof projectPath !== 'string' || typeof name !== 'string' || !data) return null
      return saveChatAttachment(projectPath, name, Buffer.from(data))
    }
  )
}

async function checkoutOf(projectPath: string): Promise<string> {
  const resolved = path.resolve(projectPath)
  const info = await gitInfo(resolved)
  return path.resolve(owningWorktree(resolved, info.worktrees ?? [])?.path ?? resolved)
}

function registerSessionIpc(): void {
  host.handle('session:last', () => lastProjectPath())
  host.handle('session:openProjects', () => loadOpenProjects())
  host.handle(
    'session:saveOpenProjects',
    async (_e, paths: string[], activePath: string | null) => {
      const next = Array.isArray(paths) ? paths : []
      const previous = (await loadOpenProjects()).paths
      await saveOpenProjects(next, activePath)
      const closed = closedProjects(previous, next)
      if (!closed.length) return
      // Todos are keyed by the checkout a chat resolves to, not the opened path —
      // a subdirectory project still shares its repo root's list. Only forget a
      // checkout once no remaining project points at it.
      const openCheckouts = new Set(await Promise.all(next.map(checkoutOf)))
      await Promise.all(
        closed.map(async (projectPath) => {
          const checkout = await checkoutOf(projectPath)
          if (!openCheckouts.has(checkout)) await todos.forget(checkout)
        })
      )
    }
  )
  host.handle('session:load', async (_e, projectPath: string) => {
    const session = await loadProjectSession(projectPath, projectPath)
    void pruneDelegateSnapshots(projectPath, session)
    return session
  })
  host.handle('session:save', (_e, projectPath: string, session: unknown, last: boolean) => {
    if (typeof projectPath !== 'string') return
    return saveProjectSession(
      projectPath,
      session as Parameters<typeof saveProjectSession>[1],
      !!last
    )
  })
  host.handle('session:clearLast', () => clearLastProject())
  host.handle('todos:load', async (_e, projectPath: unknown) => {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      throw new Error('Invalid project path')
    }
    const checkout = await checkoutOf(projectPath)
    return { checkout, todos: await todos.load(checkout) }
  })
  host.handle('todos:save', async (_e, checkout: unknown, value: unknown, expected: unknown) => {
    if (typeof checkout !== 'string' || !checkout.trim()) {
      throw new Error('Invalid checkout path')
    }
    const next = parseTodos(value)
    const previous = parseTodos(expected)
    if (!next || !previous) throw new Error('Invalid todo list')
    const key = path.resolve(checkout)
    const { paths } = await loadOpenProjects()
    const checkouts = await Promise.all(paths.map(checkoutOf))
    if (!checkouts.includes(key)) throw new Error('Not an open checkout')
    await todos.save(key, mergeTodos(previous, next, undefined, Date.now()), previous)
  })
  host.handle('pipelines:load', async (_e, projectPath: string) => {
    void pipelineFiles.watch(projectPath)
    const pipelines = await loadPipelines(projectPath)
    void syncProjectGitHooks(projectPath, projectPath, pipelines)
    return pipelines
  })
  host.handle('pipelines:save', (_e, projectPath: string, pipelines: Pipeline[]) =>
    savePipelines(projectPath, pipelines)
  )
}

function registerShellIpc(): void {
  host.handle(
    'shell:open',
    (_e, paneId: string, cwd: string, cols?: number, rows?: number, provider?: unknown) =>
      shells.open(paneId, cwd, cols, rows, isAiProvider(provider) ? provider : undefined)
  )
  host.handle('shell:write', (_e, paneId: string, data: string) => shells.write(paneId, data))
  host.handle('shell:resize', (_e, paneId: string, cols: number, rows: number) =>
    shells.resize(paneId, cols, rows)
  )
  host.handle('shell:dispose', (_e, paneId: string) => shells.dispose(paneId))
  host.handle('shell:send', (_e, paneId: string, data: string) => shells.send(paneId, data))
}

function registerGitIpc(): void {
  host.handle('git:info', async (_e, projectPath: string) => {
    void head.watch(projectPath)
    return gitInfo(projectPath)
  })
  host.handle('git:checkout', (_e, projectPath: string, branch: string) =>
    checkout(projectPath, branch)
  )
  host.handle('git:worktree', async (_e, projectPath: string, req: WorktreeRequest) => {
    const res = await addWorktree(projectPath, req)
    if (res.ok && res.path && res.path !== projectPath) {
      installMcpConfig(res.path, projectPath)
      void syncProjectGitHooks(res.path, projectPath)
    }
    return res
  })
  host.handle('git:status', (_e, projectPath: string, base?: string) =>
    gitStatus(projectPath, typeof base === 'string' ? base : undefined)
  )
  host.handle('git:recentCommits', (_e, projectPath: string) => recentCommits(projectPath))
  host.handle(
    'git:draftCommit',
    async (
      _e,
      projectPath: string,
      provider: AgentTaskRequest['provider'],
      model?: string,
      files?: string[]
    ) => {
      const cwd = await openProjectCwd(projectPath)
      if ('error' in cwd) return cwd
      return draftCommit(
        cwd.path,
        provider,
        typeof model === 'string' ? model : undefined,
        Array.isArray(files) ? files.filter((file) => typeof file === 'string') : undefined
      )
    }
  )
  host.handle(
    'git:commit',
    async (_e, projectPath: string, message: string, files?: string[]) => {
      const cwd = await openProjectCwd(projectPath)
      if ('error' in cwd) return cwd
      return commitAll(
        cwd.path,
        typeof message === 'string' ? message : '',
        Array.isArray(files) ? files.filter((f) => typeof f === 'string') : undefined
      )
    }
  )
  host.handle('git:push', async (_e, projectPath: string) => {
    const cwd = await openProjectCwd(projectPath)
    if ('error' in cwd) return { ok: false, message: cwd.error }
    return gitPush(cwd.path)
  })
  host.handle('git:pull', async (_e, projectPath: string) => {
    const cwd = await openProjectCwd(projectPath)
    if ('error' in cwd) return { ok: false, message: cwd.error }
    return gitPull(cwd.path)
  })
  host.handle('git:hooks', (_e, projectPath: string) => hooksInfo(projectPath))
  host.handle('git:github', (_e, projectPath: string) => githubStatus(projectPath))
  host.handle(
    'git:createPr',
    async (_e, projectPath: string, base?: string, title?: string, body?: string) => {
      const cwd = await openProjectCwd(projectPath)
      if ('error' in cwd) return { ok: false, message: cwd.error }
      return createPullRequest(
        cwd.path,
        typeof base === 'string' ? base : undefined,
        typeof title === 'string' ? title : undefined,
        typeof body === 'string' ? body : undefined
      )
    }
  )
  host.handle(
    'git:draftPr',
    async (
      _e,
      projectPath: string,
      provider: AgentTaskRequest['provider'],
      model?: string,
      base?: string
    ) => {
      const cwd = await openProjectCwd(projectPath)
      if ('error' in cwd) return cwd
      return draftPullRequest(
        cwd.path,
        provider,
        typeof model === 'string' ? model : undefined,
        typeof base === 'string' ? base : undefined
      )
    }
  )
  host.handle('git:mergePr', async (_e, projectPath: string, strategy: MergeStrategy) => {
    const cwd = await openProjectCwd(projectPath)
    if ('error' in cwd) return { ok: false, message: cwd.error }
    return mergePullRequest(cwd.path, strategy)
  })
  host.handle('git:bringConflicts', async (_e, projectPath: string, base?: string) => {
    const cwd = await openProjectCwd(projectPath)
    if ('error' in cwd) return { ok: false, message: cwd.error }
    return bringPrConflicts(cwd.path, typeof base === 'string' ? base : undefined)
  })
}

function registerTaskIpc(): void {
  host.handle('run:start', (_e, pipeline: Pipeline, cwd: string, branch: string) =>
    runner.start(pipeline, cwd, branch)
  )
  host.handle('run:cancel', (_e, pipelineId: string) => runner.cancelAndWait(pipelineId))
  host.handle('agent:start', (_e, request: AgentTaskRequest) => agents.start(request))
  host.handle('agent:freshStart', (_e, taskId: string) => agents.freshStart(taskId))
  host.handle(
    'agent:message',
    (
      _e,
      taskId: string,
      text: string,
      provider?: AgentTaskRequest['provider'],
      pipelines?: AgentTaskRequest['pipelines'],
      model?: string,
      mode?: AgentTaskRequest['mode'],
      fallbacks?: AgentTaskRequest['fallbacks'],
      cwd?: string,
      checkout?: string,
      effort?: unknown
    ) => agents.message(taskId, text, provider, pipelines, model, mode, fallbacks, cwd, checkout, normalizeEffort(effort))
  )
  host.handle(
    'agent:setProvider',
    (_e, taskId: string, provider: AgentTaskRequest['provider'], model?: string, mode?: AgentTaskRequest['mode']) =>
      agents.setProvider(taskId, provider, model, mode)
  )
  host.handle('agent:cancel', (_e, taskId: string) => agents.cancel(taskId))
  host.handle('agent:dispose', (_e, taskId: string) => agents.dispose(taskId))
  host.handle('agent:respondApproval', (_e, taskId: string, requestId: string, decision: unknown) =>
    decision === 'once' || decision === 'chat' || decision === 'deny'
      ? agents.respondApproval(taskId, requestId, decision)
      : { ok: false, message: 'Unknown decision.' }
  )
  host.handle('agent:setAutoApprove', (_e, taskId: string, on: unknown) => agents.setAutoApprove(taskId, on !== false))
  host.handle('agent:undoDelegate', (_e, taskId: string, delegateId: string, restore?: boolean) =>
    agents.undoDelegate(taskId, delegateId, restore === true)
  )
  host.handle(
    'agent:answer',
    (_e, taskId: string, requestId: string, answers: string[][] | null) =>
      agents.answer(taskId, requestId, answers)
  )
  registerTurnIpc()
}

/** Per-turn checkpoints: list, preview a revert, revert. Input comes from the renderer, so it is checked. */
function registerTurnIpc(): void {
  const turnArgs = (taskId: unknown, turn: unknown, cwd: unknown) =>
    typeof taskId === 'string' && Number.isInteger(turn) && (turn as number) > 0 && (cwd === undefined || typeof cwd === 'string')
  host.handle('agent:turns', (_e, taskId: unknown, cwd?: unknown) =>
    typeof taskId === 'string' && (cwd === undefined || typeof cwd === 'string') ? agents.turns(taskId, cwd) : []
  )
  host.handle('agent:revertPreview', (_e, taskId: unknown, turn: unknown, cwd?: unknown) =>
    turnArgs(taskId, turn, cwd) ? agents.revertPreview(taskId as string, turn as number, cwd as string | undefined) : { message: 'Invalid request.' }
  )
  host.handle('agent:revertTurn', (_e, taskId: unknown, turn: unknown, cwd?: unknown) =>
    turnArgs(taskId, turn, cwd)
      ? agents.revertTurn(taskId as string, turn as number, cwd as string | undefined)
      : { ok: false, message: 'Invalid request.' }
  )
}

function projectPathOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** Memory of agent sessions. The renderer names a session; the pids come from Farol's own snapshot. */
function registerProcIpc(): void {
  host.handle('proc:snapshot', () => withLimits(procSampler.latest))
  host.handle('proc:ports', async (_e, sessionId: unknown) => {
    const usage = procSampler.latest.worktrees.flatMap((w) => w.sessions).find((s) => s.sessionId === sessionId)
    return usage ? Object.fromEntries(await listPorts(usage.procs.map((p) => p.pid), procSampler.signal)) : {}
  })
  host.handle('proc:kill', (_e, sessionId: unknown, pid: unknown) =>
    typeof sessionId === 'string' && (pid === undefined || Number.isInteger(pid))
      ? procCleanup.kill(sessionId, pid as number | undefined)
      : { ok: false, message: 'Bad request.', terminated: 0, killed: 0 }
  )
}

function registerBackendAppIpc(): void {
  host.handle('prompts:load', (_e, projectPath: unknown) => prompts.load(projectPathOrNull(projectPath)))
  host.handle('prompts:saveGlobal', (_e, projectPath: unknown, value: unknown) =>
    prompts.saveGlobal(projectPathOrNull(projectPath), value)
  )
  host.handle('prompts:saveProject', (_e, projectPath: unknown, value: unknown) =>
    prompts.saveProject(projectPathOrNull(projectPath) ?? '', value)
  )
  host.handle('prompts:setProjectActive', (_e, projectPath: unknown, ids: unknown) =>
    prompts.setProjectActive(projectPathOrNull(projectPath) ?? '', ids)
  )
  host.handle('agents:scan', scanAgents)
  host.handle('agentModels:refresh', (_e, force?: boolean) =>
    refreshAgentCatalogs({ forceRefresh: force === true })
  )
  host.handle('usage:read', providerUsage)
}
/** Open `dir` as a project: remember it, point agents' MCP config at it, and start its bridge. */
async function openProjectAt(dir: string): Promise<Project | null> {
  if (typeof dir !== 'string' || !fs.existsSync(dir)) return null
  const project = toProject(dir)
  await pushRecent(project)
  installMcpConfig(project.path)
  startBridge(project.path)
  void syncProjectGitHooks(project.path)
  return project
}

export interface Backend {
  openProject(dir: string): Promise<Project | null>
  /** Apply settings the backend acts on (memory limits). */
  applySettings(settings: AppSettings): void
  /** Stop agents, shells, runs, watchers and bridges. */
  stop(): void
}

let started: Backend | null = null

/** Register every backend handler on `h` and start its background work. Once per process. */
export function startBackend(h: BackendHost): Backend {
  if (started) return started
  host = h
  registerProjectIpc()
  registerSessionIpc()
  registerShellIpc()
  registerGitIpc()
  registerTaskIpc()
  registerProcIpc()
  registerBackendAppIpc()
  startManagedBridge()
  void loadSettings().then(rememberMemoryLimits)
  procSampler.start()
  started = {
    openProject: openProjectAt,
    applySettings: (settings) => rememberMemoryLimits(sanitizeSettings(settings)),
    stop: () => {
      procCleanup.stop()
      agents.cancelAll()
      shells.disposeAll()
      runner.cancelAll()
      procSampler.stop()
      head.stop()
      pipelineFiles.stop()
      for (const server of bridges.values()) server.close()
      bridges.clear()
    }
  }
  return started
}
