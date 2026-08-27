import { app, BrowserWindow, dialog, ipcMain, Menu, shell as electronShell } from 'electron'
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
import { HeadWatcher, addWorktree, checkout, info as gitInfo } from './git'
import { PipelineRunner } from './runner'
import { loadPipelines, pushRecent, readRecents, savePipelines, toProject, lastProjectPath, loadOpenProjects, saveOpenProjects, loadProjectSession, saveProjectSession, clearLastProject, loadSettings, saveSettings } from './store'
import { listProjectFiles } from './files'
import { AppUpdater } from './update'
import { applyGlass, glassAvailable } from './glass'
import { mergeMcpConfig, MCP_CONFIG_REL_PATHS, type McpServerEntry } from '../shared/mcp-config'
import { BRIDGE_ENV, socketPathFor, takeLines, type BridgeReply, type BridgeRequest } from '../shared/bridge'
import { resolvePipeline, topoSort, validateRunnable } from '../shared/graph'
import { plainText } from '../shared/terminal'
import { AgentController } from './agent-controller'
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
const agents = new AgentController(runner, (event) => send('agent:event', event))
const head = new HeadWatcher(async (cwd) =>
  send('git:changed', { projectPath: cwd, info: await gitInfo(cwd) })
)
const updater = new AppUpdater((s) => send('update:status', s))

function createWindow(): void {
  const wantGlass = glassAvailable()
  glassActive = false

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 520,
    show: false,
    frame: false,
    // Liquid Glass needs a transparent window and must not use vibrancy.
    transparent: wantGlass,
    backgroundColor: wantGlass ? '#00000000' : '#1c1c1e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win?.show())
  win.on('closed', () => {
    win = null
    glassActive = false
  })

  // Keep navigation inside the app; send real http(s) links to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void electronShell.openExternal(url)
    return { action: 'deny' }
  })

  if (wantGlass) {
    win.webContents.once('did-finish-load', () => {
      if (!win || win.isDestroyed()) return
      glassActive = applyGlass(win)
      send('ui:glass', glassActive)
    })
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
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
 * Point agents at this project's pipelines by declaring BuildFlow's MCP server
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
          output.set(e.nodeId, (output.get(e.nodeId) ?? '') + plainText(e.chunk))
        } else if (e.kind === 'step-end') {
          status.set(e.nodeId, { label: e.skipped ? 'SKIP' : e.ok ? 'PASS' : 'FAIL', code: e.code })
        } else if (e.kind === 'end') {
          const lines = [
            `${e.cancelled ? 'CANCELLED' : e.ok ? 'PASSED' : 'FAILED'}: ${pipeline.name} on ${branch}`,
            ''
          ]
          for (const n of nodes) {
            const st = status.get(n.id) ?? { label: 'SKIP', code: 0 }
            lines.push(`[${st.label}] ${n.name || n.id}${st.label === 'FAIL' ? ` (exit ${st.code})` : ''}`)
          }
          for (const n of nodes) {
            if (status.get(n.id)?.label !== 'FAIL') continue
            const text = (output.get(n.id) ?? '').trim().slice(-AGENT_STEP_OUTPUT_LIMIT)
            if (text) lines.push('', `--- output: ${n.name || n.id} ---`, text)
          }
          finish(lines.join('\n'), !e.ok)
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
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
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
 * Last opened project wins for the shared `buildflow` key.
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

function registerIpc(): void {
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

  ipcMain.handle('session:last', () => lastProjectPath())
  ipcMain.handle('session:openProjects', () => loadOpenProjects())
  ipcMain.handle(
    'session:saveOpenProjects',
    (_e, paths: string[], activePath: string | null) =>
      saveOpenProjects(Array.isArray(paths) ? paths : [], activePath)
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

  ipcMain.handle('pipelines:load', (_e, projectPath: string) => loadPipelines(projectPath))

  ipcMain.handle('pipelines:save', (_e, projectPath: string, pipelines: Pipeline[]) =>
    savePipelines(projectPath, pipelines)
  )

  ipcMain.handle('shell:open', (_e, paneId: string, cwd: string, cols?: number, rows?: number) =>
    shells.open(paneId, cwd, cols, rows)
  )
  ipcMain.handle('shell:write', (_e, paneId: string, data: string) => shells.write(paneId, data))
  ipcMain.handle('shell:resize', (_e, paneId: string, cols: number, rows: number) =>
    shells.resize(paneId, cols, rows)
  )
  ipcMain.handle('shell:dispose', (_e, paneId: string) => shells.dispose(paneId))
  ipcMain.handle('shell:send', (_e, paneId: string, data: string) => shells.send(paneId, data))

  ipcMain.handle('git:info', async (_e, projectPath: string) => {
    void head.watch(projectPath)
    return gitInfo(projectPath)
  })
  ipcMain.handle('git:checkout', (_e, projectPath: string, branch: string) =>
    checkout(projectPath, branch)
  )
  ipcMain.handle('git:worktree', async (_e, projectPath: string, req: WorktreeRequest) => {
    const res = await addWorktree(projectPath, req)
    // Agents working in the worktree reach the same app instance.
    if (res.ok && res.path && res.path !== projectPath) installMcpConfig(res.path, projectPath)
    return res
  })

  ipcMain.handle('run:start', (_e, pipeline: Pipeline, cwd: string, branch: string) =>
    runner.start(pipeline, cwd, branch)
  )
  ipcMain.handle('run:cancel', (_e, pipelineId: string) => runner.cancelAndWait(pipelineId))

  ipcMain.handle('agent:start', (_e, request: AgentTaskRequest) => agents.start(request))
  ipcMain.handle(
    'agent:message',
    (_e, taskId: string, text: string, provider?: AgentTaskRequest['provider']) =>
      agents.message(taskId, text, provider)
  )
  ipcMain.handle('agent:cancel', (_e, taskId: string) => agents.cancel(taskId))

  ipcMain.handle('settings:load', () => loadSettings())
  ipcMain.handle('settings:save', (_e, settings: AppSettings) => saveSettings(settings))

  ipcMain.handle('update:check', () => updater.check())
  ipcMain.on('update:install', () => updater.install())

  ipcMain.handle('ui:glass', () => glassActive)
  ipcMain.on('window:minimize', () => win?.minimize())
  ipcMain.on('window:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
  ipcMain.on('window:close', () => win?.close())
}

app.whenReady().then(() => {
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
  for (const server of bridges.values()) server.close()
  bridges.clear()
})
