import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell as electronShell } from 'electron'
import path from 'path'
import fs from 'fs'
import type {
  AgentTaskRequest,
  AppSettings,
  Pipeline,
  RunEvent,
  ShellCwd,
  ShellData,
  ShellExit,
  WorktreeRequest
} from '../shared/types'
import { ShellManager } from './shell'
import { HeadWatcher, addWorktree, bringPrConflicts, checkout, commitAll, draftCommit, githubStatus, info as gitInfo, pull as gitPull, push as gitPush, recentCommits, status as gitStatus } from './git'
import { createPullRequest } from './github'
import { PipelineRunner } from './runner'
import { loadPipelines, pushRecent, readRecents, savePipelines, toProject, lastProjectPath, loadOpenProjects, saveOpenProjects, loadProjectSession, saveProjectSession, clearLastProject, loadSettings, saveSettings, PipelineWatcher } from './store'
import {
  clearOpenRouter,
  refreshOpenRouterCatalog,
  saveOpenRouterKey,
  setOpenRouterPinned
} from './openrouter'
import { listProjectFiles, saveChatAttachment } from './files'
import { listAgentSkills } from './skills'
import { AppUpdater } from './update'
import { applyGlass, glassAvailable } from './glass'
import { providerUsage } from './usage'
import { mergeMcpConfig, MCP_CONFIG_REL_PATHS, type McpServerEntry } from '../shared/mcp-config'
import { BRIDGE_ENV, socketPathFor, takeLines, type BridgeReply, type BridgeRequest } from '../shared/bridge'
import { isAiProvider } from '../shared/ai'
import { resolvePipeline, topoSort, validateRunnable } from '../shared/graph'
import { appendTail, plainText } from '../shared/terminal'
import { AgentController } from './agent-controller'
import { createTodoStore } from './todos'
import { closedProjects } from '../shared/session'
import { owningWorktree } from '../shared/worktree'
import { scopedRuntimeId } from '../shared/runtime'
import net from 'net'
import os from 'os'

let win: BrowserWindow | null = null
/** Renderer chrome goes translucent only when the native glass view is up. */
let glassActive = false

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

const shells = new ShellManager(
  (e: ShellData) => send('shell:data', e),
  (e: ShellExit) => send('shell:exit', e),
  (e: ShellCwd) => send('shell:cwd', e)
)
const runner = new PipelineRunner((e: RunEvent) => {
  send('run:event', e)
  for (const run of agentRuns) run.onEvent(e)
})
const todos = createTodoStore(() => app.getPath('userData'))
const agents = new AgentController(runner, (event) => send('agent:event', event), undefined, todos)
const head = new HeadWatcher(async (cwd) =>
  send('git:changed', { projectPath: cwd, info: await gitInfo(cwd) })
)
const pipelineFiles = new PipelineWatcher((projectPath, pipelines) =>
  send('pipelines:changed', { projectPath, pipelines })
)
const updater = new AppUpdater((s) => send('update:status', s))

function brandIconCandidates(): string[] {
  const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../build')
  // Prefer PNG for dock.setIcon; keep .icns as a fallback for Finder/About.
  return [path.join(root, 'icon.png'), path.join(root, 'icon.icns')]
}

function loadBrandIcon(): Electron.NativeImage | undefined {
  for (const candidate of brandIconCandidates()) {
    if (!fs.existsSync(candidate)) continue
    const image = nativeImage.createFromPath(candidate)
    if (!image.isEmpty()) return image
  }
  return undefined
}

function createWindow(): void {
  const wantGlass = glassAvailable()
  glassActive = false
  const icon = loadBrandIcon()

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 520,
    show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    // Liquid Glass needs a transparent window and must not use vibrancy.
    transparent: wantGlass,
    backgroundColor: wantGlass ? '#00000000' : '#181817',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const loadRenderer = (): void => {
    if (!win || win.isDestroyed()) return
    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void win.loadFile(path.join(__dirname, '../renderer/index.html'))
    }
  }

  win.on('ready-to-show', () => {
    // Re-apply after the window exists — Dock can ignore an early setIcon
    // while Launch Services still thinks this binary is stock Electron.
    applyBrandIcon()
    win?.show()
  })
  win.on('closed', () => {
    win = null
    glassActive = false
  })

  // Keep navigation inside the app; send real http(s) links to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void electronShell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  // OOM / GPU faults kill the renderer and leave an empty frame — reload it.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[farol] renderer process gone', details)
    loadRenderer()
  })
  win.webContents.on('unresponsive', () => {
    console.error('[farol] renderer unresponsive')
  })

  if (wantGlass) {
    win.webContents.once('did-finish-load', () => {
      if (!win || win.isDestroyed()) return
      glassActive = applyGlass(win)
      send('ui:glass', glassActive)
    })
  }

  loadRenderer()
}

/**
 * A deliberately small menu: the renderer owns ⌘T / ⌘W / ⌘1–9 (tab commands),
 * so those accelerators are kept off the menu where they would win.
 */
function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? ([
            {
              label: app.name,
              submenu: [
                { role: 'about' },
                {
                  label: 'Check for Updates…',
                  click: () => void updater.check({ informNone: true })
                },
                { type: 'separator' },
                {
                  label: 'Settings…',
                  accelerator: 'CmdOrCtrl+,',
                  click: () => send('ui:settings', undefined)
                },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
              ]
            }
          ] as Electron.MenuItemConstructorOptions[])
        : []),
      {
        label: 'File',
        submenu: [
          {
            label: 'Open Project…',
            accelerator: 'CmdOrCtrl+O',
            click: async () => {
              const p = await openProjectDialog()
              if (p) send('project:opened', p)
            }
          },
          ...(isMac
            ? []
            : ([
                { type: 'separator' },
                {
                  label: 'Settings…',
                  accelerator: 'CmdOrCtrl+,',
                  click: () => send('ui:settings', undefined)
                }
              ] as Electron.MenuItemConstructorOptions[])),
          { type: 'separator' },
          // Not `role: 'close'` — that would claim ⌘W, which closes a tab here.
          isMac
            ? { label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W', click: () => win?.close() }
            : { role: 'quit' }
        ]
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      }
    ])
  )
}

async function openProjectDialog() {
  if (!win) return null
  const res = await dialog.showOpenDialog(win, {
    title: 'Open Project',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Open'
  })
  if (res.canceled || !res.filePaths.length) return null
  const project = toProject(res.filePaths[0])
  await pushRecent(project)
  installMcpConfig(project.path)
  startBridge(project.path)
  return project
}

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

async function handleBridge(req: BridgeRequest, projectPath: string): Promise<BridgeReply> {
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

function startBridge(projectPath: string): void {
  const file = socketPath(projectPath)
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
        void handleBridge(req, projectPath)
          .then((reply) => socket.write(JSON.stringify(reply) + '\n'))
          .catch((err) =>
            socket.write(
              JSON.stringify({
                id: req.id,
                ok: false,
                message: err instanceof Error ? err.message : String(err)
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
}

function socketPath(projectPath: string): string {
  return socketPathFor(projectPath, os.tmpdir(), path.sep)
}

function mcpEntry(projectPath: string): McpServerEntry {
  return {
    command: process.execPath,
    args: [path.join(app.getAppPath(), 'out', 'main', 'mcp.js')],
    env: { ELECTRON_RUN_AS_NODE: '1', [BRIDGE_ENV]: socketPath(projectPath) }
  }
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
  ipcMain.handle('project:open', () => openProjectDialog())
  ipcMain.handle('project:openPath', async (_e, dir: string) => {
    if (typeof dir !== 'string' || !fs.existsSync(dir)) return null
    const project = toProject(dir)
    await pushRecent(project)
    installMcpConfig(project.path)
    startBridge(project.path)
    return project
  })
  ipcMain.handle('project:recents', () => readRecents())
  ipcMain.handle('project:listFiles', (_e, projectPath: string, query?: string) =>
    listProjectFiles(projectPath, typeof query === 'string' ? query : '')
  )
  ipcMain.handle('project:listSkills', (_e, projectPath: string, provider: unknown) =>
    typeof projectPath === 'string' && isAiProvider(provider)
      ? listAgentSkills(projectPath, provider)
      : []
  )
  ipcMain.handle(
    'project:saveAttachment',
    (_e, projectPath: string, name: string, data: ArrayBuffer) => {
      if (typeof projectPath !== 'string' || typeof name !== 'string' || !data) return null
      return saveChatAttachment(projectPath, name, Buffer.from(data))
    }
  )
}

function registerSessionIpc(): void {
  ipcMain.handle('session:last', () => lastProjectPath())
  ipcMain.handle('session:openProjects', () => loadOpenProjects())
  ipcMain.handle(
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
      const checkoutOf = async (projectPath: string): Promise<string> => {
        const info = await gitInfo(projectPath)
        return path.resolve(owningWorktree(projectPath, info.worktrees ?? [])?.path ?? projectPath)
      }
      const openCheckouts = new Set(await Promise.all(next.map(checkoutOf)))
      await Promise.all(
        closed.map(async (projectPath) => {
          const checkout = await checkoutOf(projectPath)
          if (!openCheckouts.has(checkout)) await todos.forget(checkout)
        })
      )
    }
  )
  ipcMain.handle('session:load', (_e, projectPath: string) =>
    loadProjectSession(projectPath, projectPath)
  )
  ipcMain.handle('session:save', (_e, projectPath: string, session: unknown, last: boolean) => {
    if (typeof projectPath !== 'string') return
    return saveProjectSession(
      projectPath,
      session as Parameters<typeof saveProjectSession>[1],
      !!last
    )
  })
  ipcMain.handle('session:clearLast', () => clearLastProject())
  ipcMain.handle('pipelines:load', async (_e, projectPath: string) => {
    void pipelineFiles.watch(projectPath)
    return loadPipelines(projectPath)
  })
  ipcMain.handle('pipelines:save', (_e, projectPath: string, pipelines: Pipeline[]) =>
    savePipelines(projectPath, pipelines)
  )
}

function registerShellIpc(): void {
  ipcMain.handle(
    'shell:open',
    (_e, paneId: string, cwd: string, cols?: number, rows?: number, provider?: unknown) =>
      shells.open(paneId, cwd, cols, rows, isAiProvider(provider) ? provider : undefined)
  )
  ipcMain.handle('shell:write', (_e, paneId: string, data: string) => shells.write(paneId, data))
  ipcMain.handle('shell:resize', (_e, paneId: string, cols: number, rows: number) =>
    shells.resize(paneId, cols, rows)
  )
  ipcMain.handle('shell:dispose', (_e, paneId: string) => shells.dispose(paneId))
  ipcMain.handle('shell:send', (_e, paneId: string, data: string) => shells.send(paneId, data))
}

function registerGitIpc(): void {
  ipcMain.handle('git:info', async (_e, projectPath: string) => {
    void head.watch(projectPath)
    return gitInfo(projectPath)
  })
  ipcMain.handle('git:checkout', (_e, projectPath: string, branch: string) =>
    checkout(projectPath, branch)
  )
  ipcMain.handle('git:worktree', async (_e, projectPath: string, req: WorktreeRequest) => {
    const res = await addWorktree(projectPath, req)
    if (res.ok && res.path && res.path !== projectPath) installMcpConfig(res.path, projectPath)
    return res
  })
  ipcMain.handle('git:status', (_e, projectPath: string) => gitStatus(projectPath))
  ipcMain.handle('git:recentCommits', (_e, projectPath: string) => recentCommits(projectPath))
  ipcMain.handle(
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
  ipcMain.handle(
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
  ipcMain.handle('git:push', async (_e, projectPath: string) => {
    const cwd = await openProjectCwd(projectPath)
    if ('error' in cwd) return { ok: false, message: cwd.error }
    return gitPush(cwd.path)
  })
  ipcMain.handle('git:pull', async (_e, projectPath: string) => {
    const cwd = await openProjectCwd(projectPath)
    if ('error' in cwd) return { ok: false, message: cwd.error }
    return gitPull(cwd.path)
  })
  ipcMain.handle('git:github', (_e, projectPath: string) => githubStatus(projectPath))
  ipcMain.handle('git:createPr', async (_e, projectPath: string, base?: string, title?: string) => {
    const cwd = await openProjectCwd(projectPath)
    if ('error' in cwd) return { ok: false, message: cwd.error }
    return createPullRequest(cwd.path, base, title)
  })
  ipcMain.handle('git:bringConflicts', async (_e, projectPath: string) => {
    const cwd = await openProjectCwd(projectPath)
    if ('error' in cwd) return { ok: false, message: cwd.error }
    return bringPrConflicts(cwd.path)
  })
}

function registerTaskIpc(): void {
  ipcMain.handle('run:start', (_e, pipeline: Pipeline, cwd: string, branch: string) =>
    runner.start(pipeline, cwd, branch)
  )
  ipcMain.handle('run:cancel', (_e, pipelineId: string) => runner.cancelAndWait(pipelineId))
  ipcMain.handle('agent:start', (_e, request: AgentTaskRequest) => agents.start(request))
  ipcMain.handle(
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
      checkout?: string
    ) => agents.message(taskId, text, provider, pipelines, model, mode, fallbacks, cwd, checkout)
  )
  ipcMain.handle(
    'agent:setProvider',
    (_e, taskId: string, provider: AgentTaskRequest['provider'], model?: string, mode?: AgentTaskRequest['mode']) =>
      agents.setProvider(taskId, provider, model, mode)
  )
  ipcMain.handle('agent:cancel', (_e, taskId: string) => agents.cancel(taskId))
  ipcMain.handle('agent:dispose', (_e, taskId: string) => agents.dispose(taskId))
  ipcMain.handle(
    'agent:answer',
    (_e, taskId: string, requestId: string, answers: string[][] | null) =>
      agents.answer(taskId, requestId, answers)
  )
}

function registerAppIpc(): void {
  ipcMain.handle('settings:load', () => loadSettings())
  ipcMain.handle('settings:save', (_e, settings: AppSettings) => saveSettings(settings))
  ipcMain.handle('openrouter:saveKey', (_e, key: string) => saveOpenRouterKey(key))
  ipcMain.handle('openrouter:clearKey', () => clearOpenRouter())
  ipcMain.handle('openrouter:refresh', () => refreshOpenRouterCatalog())
  ipcMain.handle('openrouter:setPinned', (_e, ids: string[]) => setOpenRouterPinned(ids))
  ipcMain.handle('usage:read', () => providerUsage())
  ipcMain.handle('update:check', () => updater.check())
  ipcMain.on('update:install', () => updater.install())
  ipcMain.handle('ui:glass', () => glassActive)
}

function registerIpc(): void {
  registerProjectIpc()
  registerSessionIpc()
  registerShellIpc()
  registerGitIpc()
  registerTaskIpc()
  registerAppIpc()
}

function applyBrandIcon(): void {
  const image = loadBrandIcon()
  if (!image) return

  // Dock tiles look sharpest around 128; a raw 1024 PNG sometimes fails to paint
  // and leaves the stock Electron atom in place (especially under `electron-vite` / unsigned installs).
  const dockTile = image.resize({ width: 128, height: 128 })
  if (process.platform === 'darwin') {
    app.dock?.setIcon(dockTile.isEmpty() ? image : dockTile)
  }

  const aboutPath = brandIconCandidates().find((p) => fs.existsSync(p))
  app.setAboutPanelOptions({
    applicationName: 'Farol',
    applicationVersion: app.getVersion(),
    copyright: 'Farol',
    ...(aboutPath ? { iconPath: aboutPath } : {})
  })
}

app.whenReady().then(() => {
  applyBrandIcon()
  registerIpc()
  buildMenu()
  createWindow()
  if (app.isPackaged) setTimeout(() => void updater.check(), 2500)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  agents.cancelAll()
  shells.disposeAll()
  runner.cancelAll()
  head.stop()
  pipelineFiles.stop()
  for (const server of bridges.values()) server.close()
  bridges.clear()
})
