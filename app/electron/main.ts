import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell as electronShell } from 'electron'
import path from 'path'
import fs from 'fs'
import type { AppSettings, Project } from '../shared/types'
import { loadSettings, saveSettings, flushWorkspace } from './store'
import {
  clearOpenRouter,
  refreshOpenRouterCatalog,
  saveOpenRouterKey,
  setOpenRouterPinned
} from './openrouter'
import { REPO_URL, feedbackIssueUrl, isFeedbackTemplate, type FeedbackTemplate } from '../shared/feedback'
import { checkJev, clearJev, saveJevKey } from './jev'
import { clearProviderKey, saveProviderKey } from './provider-keys'
import { onPaymentRequired } from './billing-links'
import { openBilling, remoteBilling } from './billing'
import { cancelRemoteSignIn, remoteAccount, signOutRemote, startRemoteSignIn, waitRemoteSignIn } from './remote'
import { configureJevLogs } from './jev-log'
import { configureAgentFailureLogs } from './agent-failure-log'
import { AppUpdater } from './update'
import { clearSpendKey, readSpend, saveSpendKey, spendKeyStatus } from './spend'
import { isBackendChannel, startBackend } from './backend'
import { MachineConnection } from './machine'
import { machineLabel, parseMachineConfig, type MachineConfig, type MachineStatus } from '../shared/machine'

let win: BrowserWindow | null = null

/** Straight to the window, whoever the event is from. */
function rawSend(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/**
 * An event from this machine's backend. While a Remote machine is in use, the
 * renderer is showing that machine's projects, so this machine's backend
 * events are not its business.
 */
function send(channel: string, payload: unknown): void {
  if (machine.active && isBackendChannel(channel)) return
  rawSend(channel, payload)
}

// ---------------------------------------------------------------------------
// Remote machine: backend channels go over SSH to a Farol server there.
// ---------------------------------------------------------------------------

/** Writes that would clobber the other side's saved workspace if they crossed a switch. */
const WORKSPACE_WRITES = new Set([
  'session:save',
  'session:saveOpenProjects',
  'session:clearLast',
  'todos:save',
  'pipelines:save'
])

/**
 * Set from the moment the backend changes sides until the reloaded window has
 * loaded: the old page's last session save (on unload) must not land on the
 * other machine as if it were that machine's workspace.
 */
let switchingSides = false
/** A routed call failed for want of a connection; reload once it is back so the UI is not left half-loaded. */
let reloadWhenConnected = false

function serverBundleDir(): string {
  // Packaged, `out/server` is unpacked from the asar so `tar` can read it.
  return path.join(app.getAppPath(), 'out', 'server').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
}

const machine = new MachineConnection({
  bundleDir: serverBundleDir(),
  version: app.getVersion(),
  onEvent: (channel, payload) => rawSend(channel, payload),
  onStatus: (status) => {
    rawSend('machine:status', status)
    // A switch already in progress reloads on its own.
    if (status.state === 'connected' && reloadWhenConnected && !switchingSides) {
      reloadWhenConnected = false
      reloadForSwitch()
    }
  }
})

interface SavedMachine {
  config: MachineConfig | null
  /** Connect on launch. */
  enabled: boolean
}

function machineFile(): string {
  return path.join(app.getPath('userData'), 'machine.json')
}

function loadSavedMachine(): SavedMachine {
  try {
    const raw = JSON.parse(fs.readFileSync(machineFile(), 'utf8')) as Partial<SavedMachine>
    const parsed = parseMachineConfig(raw.config)
    return { config: parsed.ok ? parsed.config : null, enabled: raw.enabled === true && parsed.ok }
  } catch {
    return { config: null, enabled: false }
  }
}

function saveMachine(next: SavedMachine): void {
  try {
    fs.mkdirSync(path.dirname(machineFile()), { recursive: true })
    fs.writeFileSync(machineFile(), JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch {
    /* only the launch-time reconnect is lost */
  }
}

function reloadForSwitch(): void {
  if (!win || win.isDestroyed()) return
  switchingSides = true
  win.webContents.once('did-finish-load', () => {
    switchingSides = false
  })
  win.webContents.reload()
}

/**
 * A backend handler, as the renderer reaches it: answered here, or forwarded
 * to the Remote machine while one is in use.
 */
function handleBackend(channel: string, fn: (event: unknown, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (switchingSides && WORKSPACE_WRITES.has(channel)) return undefined
    if (!machine.active) return fn(event, ...args)
    try {
      return await machine.call(channel, args)
    } catch (err) {
      if (!machine.connected) reloadWhenConnected = true
      throw err
    }
  })
}

const backend = startBackend({
  handle: handleBackend,
  send,
  userData: () => app.getPath('userData'),
  scriptPath: (file) => path.join(app.getAppPath(), 'out', 'main', file),
  procsnapPath: () =>
    path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../build'), 'procsnap'),
  isVisible: () => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()
})

async function connectMachine(input: unknown): Promise<{ ok: true; status: MachineStatus } | { ok: false; error: string }> {
  const parsed = parseMachineConfig(input)
  if (!parsed.ok) return parsed
  const previous = loadSavedMachine()
  switchingSides = true
  reloadWhenConnected = false
  try {
    await machine.connect(parsed.config)
  } catch (err) {
    // A first attempt that fails puts things back how they were, rather than leave the window waiting on a machine it cannot reach.
    machine.disconnect()
    switchingSides = false
    if (previous.enabled && previous.config) void machine.connect(previous.config).catch(() => undefined)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  saveMachine({ config: parsed.config, enabled: true })
  reloadForSwitch()
  return { ok: true, status: machine.status }
}

function disconnectMachine(): void {
  saveMachine({ config: loadSavedMachine().config, enabled: false })
  if (!machine.active) return
  switchingSides = true
  machine.disconnect()
  reloadForSwitch()
}

/** Opening a folder on the Remote machine: there is no native picker for it, so the renderer asks for a path. */
async function openMachineProject(dir: unknown): Promise<{ ok: true; project: Project } | { ok: false; error: string }> {
  if (typeof dir !== 'string' || !dir.trim()) return { ok: false, error: 'Enter a folder path on the remote machine.' }
  if (!machine.active) return { ok: false, error: 'Not using a remote machine.' }
  let target = dir.trim()
  const home = machine.status.home
  if (home && (target === '~' || target.startsWith('~/'))) target = home + target.slice(1)
  try {
    const project = (await machine.call('project:openPath', [target])) as Project | null
    if (!project) return { ok: false, error: `No folder at ${target} on ${machine.status.config ? machineLabel(machine.status.config) : 'the remote machine'}.` }
    rawSend('project:opened', project)
    return { ok: true, project }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function registerMachineIpc(): void {
  ipcMain.handle('machine:status', () => ({ status: machine.status, saved: loadSavedMachine().config }))
  ipcMain.handle('machine:connect', (_e, input: unknown) => connectMachine(input))
  ipcMain.handle('machine:disconnect', () => disconnectMachine())
  ipcMain.handle('machine:openProject', (_e, dir: unknown) => openMachineProject(dir))
  ipcMain.handle('machine:pickKey', async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose SSH private key',
      defaultPath: path.join(app.getPath('home'), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
      buttonLabel: 'Use Key'
    })
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0]
  })
  ipcMain.handle('machine:openAuthUrl', (_e, url: unknown) =>
    typeof url === 'string' && /^https:\/\//i.test(url) ? openInBrowser(url) : false
  )
}

// Kept on this machine either way: the updater, the menu, and keys.
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
  const icon = loadBrandIcon()

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 520,
    show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    backgroundColor: '#181817',
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
  })

  // Keep navigation inside the app; send real http(s) links to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void openInBrowser(url)
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
      },
      {
        role: 'help',
        submenu: [
          { label: 'Send Feedback…', click: () => openFeedback('feedback.yml') },
          { label: 'Report a Bug…', click: () => openFeedback('bug.yml') },
          { label: 'Suggest an Idea…', click: () => openFeedback('idea.yml') },
          { type: 'separator' },
          { label: 'Farol on GitHub', click: () => void openInBrowser(REPO_URL) }
        ]
      }
    ])
  )
}

/** Opens a GitHub issue form in the browser with this build's version and macOS version filled in. */
async function openFeedback(template: FeedbackTemplate): Promise<boolean> {
  return openInBrowser(
    feedbackIssueUrl(template, {
      appVersion: app.getVersion(),
      osVersion: process.getSystemVersion(),
      arch: process.arch
    })
  )
}

/** Opens `url` in the system browser; false when the system could not, so callers do not act as if it opened. */
async function openInBrowser(url: string): Promise<boolean> {
  try {
    await electronShell.openExternal(url)
    return true
  } catch {
    return false
  }
}

async function openProjectDialog(): Promise<Project | null> {
  if (!win) return null
  if (machine.active) {
    rawSend('machine:pickProject', undefined)
    return null
  }
  const res = await dialog.showOpenDialog(win, {
    title: 'Open Project',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Open'
  })
  if (res.canceled || !res.filePaths.length) return null
  return backend.openProject(res.filePaths[0])
}

function registerRemoteIpc(): void {
  ipcMain.handle('remote:signInStart', () => startRemoteSignIn())
  ipcMain.handle('remote:signInWait', () => waitRemoteSignIn())
  ipcMain.handle('remote:signInCancel', () => cancelRemoteSignIn())
  ipcMain.handle('remote:account', () => remoteAccount())
  ipcMain.handle('remote:signOut', () => signOutRemote())
  ipcMain.handle('remote:billing', () => remoteBilling())
  ipcMain.handle('remote:openBilling', (_e, kind: unknown) => openBilling(kind))
  ipcMain.handle('feedback:open', (_e, template: unknown) =>
    isFeedbackTemplate(template) ? openFeedback(template) : false
  )
  onPaymentRequired((e) => send('remote:paymentRequired', e))
}


function registerAppIpc(): void {
  ipcMain.handle('project:open', () => openProjectDialog())
  ipcMain.handle('settings:load', loadSettings)
  ipcMain.handle('settings:save', async (_e, settings: AppSettings) => {
    backend.applySettings(settings)
    const saved = await saveSettings(settings)
    // The remote's agents and cleanup read the same settings there.
    if (machine.connected) void machine.call('settings:save', [settings]).catch(() => undefined)
    return saved
  })
  ipcMain.handle('update:check', () => updater.check())
  ipcMain.on('update:install', () => updater.install())
}

/** Provider keys, their catalogs, and the usage and spend they unlock. */
function registerKeyIpc(): void {
  ipcMain.handle('openrouter:saveKey', (_e, key: string) => saveOpenRouterKey(key))
  ipcMain.handle('openrouter:clearKey', clearOpenRouter)
  ipcMain.handle('openrouter:refresh', refreshOpenRouterCatalog)
  ipcMain.handle('openrouter:setPinned', (_e, ids: string[]) => setOpenRouterPinned(ids))
  ipcMain.handle('providerKey:save', (_e, name: unknown, key: unknown) => saveProviderKey(name, key))
  ipcMain.handle('providerKey:clear', (_e, name: unknown) => clearProviderKey(name))
  ipcMain.handle('jev:saveKey', (_e, key: string) => saveJevKey(key))
  ipcMain.handle('jev:clearKey', clearJev)
  ipcMain.handle('jev:check', checkJev)
  ipcMain.handle('spend:read', (_e, force: unknown) => readSpend(force))
  ipcMain.handle('spend:keys', spendKeyStatus)
  ipcMain.handle('spend:saveKey', (_e, name: unknown, key: unknown) => saveSpendKey(name, key))
  ipcMain.handle('spend:clearKey', (_e, name: unknown) => clearSpendKey(name))
}

function registerIpc(): void {
  registerRemoteIpc()
  registerAppIpc()
  registerKeyIpc()
  registerMachineIpc()
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
  const userData = () => app.getPath('userData')
  configureJevLogs(userData)
  configureAgentFailureLogs(userData)
  applyBrandIcon()
  registerIpc()
  buildMenu()
  // Back on the Remote machine from last time; until it answers, the window's calls wait for it.
  const saved = loadSavedMachine()
  if (saved.enabled && saved.config) void machine.connect(saved.config).catch(() => undefined)
  createWindow()
  if (app.isPackaged) {
    setTimeout(() => void updater.check(), 2500)
    setInterval(() => void updater.check(), 6 * 60 * 60 * 1000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Quitting (a plain Cmd+Q, or the in-place updater's `app.quit()`) can race a
// settings/session write that was only just queued — see `flushWorkspace`.
// The renderer's own final write (session flush on beforeunload/pagehide)
// only fires once its window actually closes, so close windows first and let
// that write get queued before draining and letting the quit through.
let quitReady = false
let quitInProgress = false
app.on('before-quit', (event) => {
  if (quitReady) return
  event.preventDefault()
  if (quitInProgress) return
  quitInProgress = true
  void (async () => {
    backend.stop()
    // Only the SSH link goes: the remote server and its agents keep running there.
    machine.disconnect()

    await Promise.all(
      BrowserWindow.getAllWindows().map(
        (w) =>
          new Promise<void>((resolve) => {
            if (w.isDestroyed()) return resolve()
            w.once('closed', () => resolve())
            w.close()
          })
      )
    )
    await flushWorkspace().catch(() => {})
    quitReady = true
    app.quit()
  })()
})