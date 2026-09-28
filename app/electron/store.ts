import { app } from 'electron'
import fsSync, { type FSWatcher } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import type { OpenProjects, Pipeline, Project } from '../shared/types'
import { sanitizePipelines } from '../shared/graph'
import {
  sanitizeOpenProjects,
  sanitizeSession,
  type ProjectSession,
  type Workspace
} from '../shared/session'
import {
  sanitizeSettings,
  withJevKeyFlag,
  withOpenRouterKeyFlag,
  withVercelTokenFlag,
  type AppSettings
} from '../shared/settings'
import { hasSecret } from './secrets'
import { pipelineStoreRootFor } from './git'
import { migrateUserDataFiles } from './user-data-migrate'

/**
 * Pipelines live with the repo at `.farol/pipelines.json` on the primary
 * checkout, so every linked worktree shares one file and it can be committed.
 * Recent projects and the last workspace are per-machine, in userData.
 */

export function toProject(dir: string): Project {
  const abs = path.resolve(dir)
  const home = os.homedir()
  return {
    name: path.basename(abs) || abs,
    path: abs,
    display: abs === home ? '~' : abs.startsWith(home + path.sep) ? '~' + abs.slice(home.length) : abs
  }
}

const CONFIG_DIR = '.farol'
/** Pre-rename config dir — read once, then rewrite under `.farol`. */
const LEGACY_CONFIG_DIR = '.buildflow'
const CONFIG_FILE = 'pipelines.json'

/** The starter set — the pipelines the app ships with for a fresh project. */
export function defaultPipelines(): Pipeline[] {
  return [
    {
      id: 'code-review',
      name: 'Code Review',
      nodes: [
        {
          id: 'n1',
          name: 'Collect diff',
          type: 'shell',
          cmd: 'git diff main...HEAD --stat',
          after: [],
          gate: true,
          x: 186,
          y: 48
        },
        {
          id: 'n2',
          name: 'Claude review',
          type: 'ai',
          ai: 'claude',
          cmd: 'Review the diff for bugs, risks, and style',
          after: ['n1'],
          gate: false,
          x: 72,
          y: 160
        },
        {
          id: 'n3',
          name: 'Cursor review',
          type: 'ai',
          ai: 'cursor',
          cmd: 'Review the same diff independently; flag anything Claude might miss',
          after: ['n1'],
          gate: false,
          x: 300,
          y: 160
        },
        {
          id: 'n4',
          name: 'Summarize',
          type: 'ai',
          ai: 'claude',
          cmd: 'Combine both reviews into a one-paragraph summary on the run log',
          after: ['n2', 'n3'],
          gate: false,
          x: 186,
          y: 272
        }
      ]
    },
    {
      id: 'lint',
      name: 'Lint & Typecheck',
      nodes: [
        {
          id: 'n1',
          name: 'ESLint',
          type: 'shell',
          cmd: 'npx eslint . --max-warnings 0',
          after: [],
          gate: true,
          x: 72,
          y: 48
        },
        {
          id: 'n2',
          name: 'TypeScript',
          type: 'shell',
          cmd: 'npx tsc --noEmit',
          after: [],
          gate: true,
          x: 300,
          y: 48
        }
      ]
    },
    {
      id: 'full',
      name: 'Full Check',
      nodes: [
        {
          id: 'n1',
          name: 'ESLint',
          type: 'shell',
          cmd: 'npx eslint . --max-warnings 0',
          after: [],
          gate: true,
          x: 72,
          y: 48
        },
        {
          id: 'n2',
          name: 'TypeScript',
          type: 'shell',
          cmd: 'npx tsc --noEmit',
          after: [],
          gate: true,
          x: 300,
          y: 48
        },
        {
          id: 'n3',
          name: 'AI Review',
          type: 'ai',
          ai: 'cursor',
          cmd: 'Review lint/type output and the diff; flag risks',
          after: ['n1', 'n2'],
          gate: false,
          x: 186,
          y: 160
        },
        {
          id: 'n4',
          name: 'Summarize',
          type: 'ai',
          ai: 'cursor',
          cmd: 'Post a one-paragraph summary to the run log',
          after: ['n3'],
          gate: false,
          x: 186,
          y: 272
        }
      ]
    },
    {
      id: 'ship',
      name: 'Ship to GitHub',
      nodes: [
        {
          id: 'n1',
          name: 'Run tests',
          type: 'shell',
          cmd: 'npm test',
          after: [],
          gate: true,
          x: 72,
          y: 48
        },
        {
          id: 'n2',
          name: 'Build',
          type: 'shell',
          cmd: 'npm run build',
          after: ['n1'],
          gate: true,
          x: 72,
          y: 160
        },
        {
          id: 'n3',
          name: 'Push & open PR',
          type: 'shell',
          cmd: 'git push && gh pr create --fill',
          after: ['n2'],
          gate: true,
          x: 72,
          y: 272
        }
      ]
    }
  ]
}

function sanitize(raw: unknown): Pipeline[] | null {
  return sanitizePipelines(raw)
}

async function readPipelineFile(file: string): Promise<Pipeline[] | null> {
  try {
    const parsed = sanitize(JSON.parse(await fs.readFile(file, 'utf8')))
    if (parsed !== null) return parsed
  } catch {
    /* no config yet, or unreadable */
  }
  return null
}

async function writePipelineFile(root: string, pipelines: Pipeline[]): Promise<void> {
  const dir = path.join(root, CONFIG_DIR)
  await fs.mkdir(dir, { recursive: true })
  const clean = sanitize(pipelines) ?? []
  await fs.writeFile(path.join(dir, CONFIG_FILE), JSON.stringify(clean, null, 2) + '\n', 'utf8')
}

export async function loadPipelines(projectPath: string): Promise<Pipeline[]> {
  const root = await pipelineStoreRootFor(projectPath)
  const file = path.join(root, CONFIG_DIR, CONFIG_FILE)
  const loaded = await readPipelineFile(file)
  // File present (even `[]`) wins — do not reseed over an intentional empty list.
  // Only fall through when the Farol config is missing / unreadable.
  if (loaded !== null) return loaded

  // One-time migration: an older worktree may have seeded its own copy.
  const local = path.resolve(projectPath)
  if (root !== local) {
    const localPipelines = await readPipelineFile(path.join(local, CONFIG_DIR, CONFIG_FILE))
    if (localPipelines?.length) {
      await writePipelineFile(root, localPipelines).catch(() => {})
      return localPipelines
    }
  }

  // BuildFlow → Farol: adopt `.buildflow/pipelines.json` before seeding defaults.
  for (const base of root === local ? [root] : [root, local]) {
    const legacy = await readPipelineFile(path.join(base, LEGACY_CONFIG_DIR, CONFIG_FILE))
    if (legacy?.length) {
      await writePipelineFile(root, legacy).catch(() => {})
      return legacy
    }
  }

  const seeded = defaultPipelines()
  await writePipelineFile(root, seeded).catch(() => {})
  return seeded
}

export async function savePipelines(projectPath: string, pipelines: Pipeline[]): Promise<void> {
  const root = await pipelineStoreRootFor(projectPath)
  await writePipelineFile(root, pipelines)
}

/**
 * Watch `.farol/pipelines.json` so edits from an agent, another editor, or git
 * show up in the UI without restarting the app.
 */
export class PipelineWatcher {
  private watchers = new Map<string, FSWatcher>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(private onChange: (projectPath: string, pipelines: Pipeline[]) => void) {}

  async watch(projectPath: string): Promise<void> {
    if (this.watchers.has(projectPath)) return
    const root = await pipelineStoreRootFor(projectPath)
    const dir = path.join(root, CONFIG_DIR)
    try {
      await fs.mkdir(dir, { recursive: true })
      // Watch the directory: many tools replace the file (unlink + create),
      // which drops a file watcher but not a directory watcher.
      const watcher = fsSync.watch(dir, (event, filename) => {
        if (filename && filename !== CONFIG_FILE) return
        if (!filename && event !== 'rename' && event !== 'change') return
        const timer = this.timers.get(projectPath)
        if (timer) clearTimeout(timer)
        this.timers.set(
          projectPath,
          setTimeout(() => {
            this.timers.delete(projectPath)
            void loadPipelines(projectPath).then((pipelines) =>
              this.onChange(projectPath, pipelines)
            )
          }, 120)
        )
      })
      this.watchers.set(projectPath, watcher)
    } catch {
      /* not watchable — UI still refreshes on project load */
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }
}

let userDataMigration: Promise<void> | null = null

function ensureUserDataMigrated(): Promise<void> {
  if (!userDataMigration) {
    userDataMigration = migrateUserDataFiles(app.getPath('userData')).catch(() => {})
  }
  return userDataMigration
}

function recentsFile(): string {
  return path.join(app.getPath('userData'), 'recent-projects.json')
}

export async function readRecents(): Promise<Project[]> {
  await ensureUserDataMigrated()
  try {
    const raw = JSON.parse(await fs.readFile(recentsFile(), 'utf8'))
    if (!Array.isArray(raw)) return []
    const paths = raw
      .filter((p): p is { path: string } => !!p && typeof p.path === 'string')
      .map((p) => p.path)
    // Folders get moved and deleted; don't offer ones that are gone.
    const alive = await Promise.all(
      paths.map(async (p) => ((await fs.stat(p).catch(() => null))?.isDirectory() ? p : null))
    )
    return alive.filter((p): p is string => p !== null).map(toProject).slice(0, 6)
  } catch {
    return []
  }
}

export async function pushRecent(project: Project): Promise<void> {
  const prev = await readRecents()
  const next = [project, ...prev.filter((p) => p.path !== project.path)].slice(0, 6)
  await fs.mkdir(path.dirname(recentsFile()), { recursive: true })
  await fs.writeFile(recentsFile(), JSON.stringify(next, null, 2), 'utf8').catch(() => {})
}

function workspaceFile(): string {
  return path.join(app.getPath('userData'), 'workspace.json')
}

async function readWorkspace(): Promise<Workspace> {
  await ensureUserDataMigrated()
  try {
    const raw = JSON.parse(await fs.readFile(workspaceFile(), 'utf8')) as Record<string, unknown>
    const lastProject = typeof raw.lastProject === 'string' ? raw.lastProject : null
    const sessions: Workspace['sessions'] = {}
    if (raw.sessions && typeof raw.sessions === 'object') {
      for (const [k, v] of Object.entries(raw.sessions as Record<string, unknown>)) {
        const s = sanitizeSession(v)
        if (s) sessions[k] = s
      }
    }
    const { openProjects, activeProject } = sanitizeOpenProjects(
      raw.openProjects,
      raw.activeProject,
      lastProject
    )
    return { lastProject, openProjects, activeProject, sessions, settings: sanitizeSettings(raw.settings) }
  } catch {
    return {
      lastProject: null,
      openProjects: [],
      activeProject: null,
      sessions: {},
      settings: sanitizeSettings(undefined)
    }
  }
}

async function writeWorkspace(ws: Workspace): Promise<void> {
  await fs.mkdir(path.dirname(workspaceFile()), { recursive: true })
  await fs.writeFile(workspaceFile(), JSON.stringify(ws, null, 2) + '\n', 'utf8').catch(() => {})
}

let workspaceMutation: Promise<void> = Promise.resolve()

function updateWorkspace(mutator: (workspace: Workspace) => void): Promise<void> {
  workspaceMutation = workspaceMutation.then(async () => {
    const workspace = await readWorkspace()
    mutator(workspace)
    await writeWorkspace(workspace)
  })
  return workspaceMutation
}

async function isDir(p: string): Promise<boolean> {
  return (await fs.stat(p).catch(() => null))?.isDirectory() ?? false
}

export async function lastProjectPath(): Promise<string | null> {
  const ws = await readWorkspace()
  if (!ws.lastProject || !(await isDir(ws.lastProject))) return null
  return ws.lastProject
}

export async function loadOpenProjects(): Promise<OpenProjects> {
  const ws = await readWorkspace()
  const alive = await Promise.all(
    ws.openProjects.map(async (projectPath) => ((await isDir(projectPath)) ? projectPath : null))
  )
  const paths = alive.filter((projectPath): projectPath is string => projectPath !== null)
  return {
    paths,
    activePath: ws.activeProject && paths.includes(ws.activeProject) ? ws.activeProject : paths[0] ?? null
  }
}

export async function saveOpenProjects(paths: string[], activePath: string | null): Promise<void> {
  await updateWorkspace((ws) => {
    ws.openProjects = [...new Set(paths.filter(Boolean))]
    ws.activeProject =
      activePath && ws.openProjects.includes(activePath) ? activePath : ws.openProjects[0] ?? null
    // Keep old builds able to restore the active repository.
    ws.lastProject = ws.activeProject
  })
}

export async function loadProjectSession(
  projectPath: string,
  fallbackCwd: string
): Promise<ProjectSession | null> {
  const ws = await readWorkspace()
  const s = ws.sessions[projectPath]
  if (!s) return null
  const tabs = []
  for (const t of s.tabs) {
    const panes = await Promise.all(
      t.panes.map(async (p) => ({
        ...p,
        cwd: (await isDir(p.cwd)) ? p.cwd : fallbackCwd
      }))
    )
    tabs.push({ ...t, panes })
  }
  return { ...s, tabs }
}

/** Persist this project's tabs. Pass `last: false` when the user closed the project. */
export async function saveProjectSession(
  projectPath: string,
  session: ProjectSession,
  last: boolean
): Promise<void> {
  await updateWorkspace((ws) => {
    const clean = sanitizeSession(session)
    if (clean) ws.sessions[projectPath] = clean
    // `lastProject` remains a compatibility field; the multi-project restore
    // uses openProjects/activeProject and is updated independently.
    if (!ws.openProjects.length) {
      ws.lastProject = last ? projectPath : ws.lastProject === projectPath ? null : ws.lastProject
    }
  })
}

export async function loadSettings(): Promise<AppSettings> {
  const stored = sanitizeSettings((await readWorkspace()).settings)
  return withVercelTokenFlag(
    withJevKeyFlag(
      withOpenRouterKeyFlag(stored, hasSecret('openrouterApiKey')),
      hasSecret('aiGatewayApiKey')
    ),
    hasSecret('vercelSandboxToken')
  )
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await updateWorkspace((ws) => {
    const next = sanitizeSettings(settings)
    const prev = sanitizeSettings(ws.settings)
    // Keep discovered catalogs if the renderer has not adopted them yet.
    if (!next.catalogs && prev.catalogs) next.catalogs = prev.catalogs
    ws.settings = next
  })
}

export async function clearLastProject(): Promise<void> {
  await updateWorkspace((ws) => {
    ws.lastProject = null
  })
}

/** Resolves once every workspace write queued so far has hit disk. */
export function flushWorkspace(): Promise<void> {
  return workspaceMutation
}
