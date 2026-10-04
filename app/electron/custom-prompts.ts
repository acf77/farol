import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  MAX_PROMPTS,
  activePromptBlock,
  sanitizePrompts,
  type CustomPrompt,
  type CustomPromptSet
} from '../shared/custom-prompts'

/**
 * Global prompts and which project prompts are switched on live in userData;
 * project prompts live with the repo at `.farol/prompts.json` on the primary
 * checkout, so every linked worktree shares one file and it can be committed.
 * The repo file never decides what is active — a cloned repo cannot switch its
 * own instructions on.
 */

const USER_FILE = 'custom-prompts.json'
const PROJECT_DIR = '.farol'
const PROJECT_FILE = 'prompts.json'

interface UserData {
  global: CustomPrompt[]
  /** Primary checkout → ids of the project prompts switched on there. */
  projectActive: Record<string, string[]>
}

export interface CustomPromptStore {
  load(projectPath: string | null): Promise<CustomPromptSet>
  saveGlobal(projectPath: string | null, prompts: unknown): Promise<CustomPromptSet>
  saveProject(projectPath: string, prompts: unknown): Promise<CustomPromptSet>
  setProjectActive(projectPath: string, ids: unknown): Promise<CustomPromptSet>
  /** The `<custom_instructions>` block for a chat in `checkout`; never throws. */
  activeBlock(checkout: string): Promise<string>
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const ids = raw.filter((id): id is string => typeof id === 'string' && !!id.trim()).map((id) => id.trim())
  return [...new Set(ids)].slice(0, MAX_PROMPTS)
}

function sanitizeUserData(raw: unknown): UserData {
  const record = isRecord(raw) ? raw : {}
  const projectActive: Record<string, string[]> = {}
  if (isRecord(record.projectActive)) {
    for (const [root, ids] of Object.entries(record.projectActive)) {
      const clean = sanitizeIds(ids)
      if (clean.length) projectActive[root] = clean
    }
  }
  return { global: sanitizePrompts(record.global), projectActive }
}

/** Missing → null; unreadable or not JSON → throws, so a save never clobbers it. */
async function readJson(file: string): Promise<unknown> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`Could not read ${path.basename(file)}`, { cause: error })
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** `userDataDir` is a thunk so this can be built before Electron is ready. */
export function createCustomPromptStore(
  userDataDir: () => string,
  rootFor: (projectPath: string) => Promise<string>
): CustomPromptStore {
  let queue: Promise<unknown> = Promise.resolve()
  const userFile = (): string => path.join(userDataDir(), USER_FILE)
  const projectFile = (root: string): string => path.join(root, PROJECT_DIR, PROJECT_FILE)

  /** Serialize writes, but let a failed one settle so later ones still run. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task)
    queue = result.then(
      () => {},
      () => {}
    )
    return result
  }

  async function readUser(): Promise<UserData> {
    return sanitizeUserData(await readJson(userFile()))
  }

  async function readProject(root: string): Promise<CustomPrompt[]> {
    return sanitizePrompts(await readJson(projectFile(root)))
  }

  async function rootOf(projectPath: string | null): Promise<string | null> {
    if (typeof projectPath !== 'string' || !projectPath.trim()) return null
    return path.resolve(await rootFor(path.resolve(projectPath)))
  }

  async function snapshot(projectPath: string | null): Promise<CustomPromptSet> {
    const root = await rootOf(projectPath)
    const user = await readUser().catch((): UserData => ({ global: [], projectActive: {} }))
    if (!root) return { global: user.global, project: [], activeProjectIds: [], projectRoot: null }
    const project = await readProject(root).catch((): CustomPrompt[] => [])
    const known = new Set(project.map((prompt) => prompt.id))
    const activeProjectIds = (user.projectActive[root] ?? []).filter((id) => known.has(id))
    return { global: user.global, project, activeProjectIds, projectRoot: root }
  }

  function requireRoot(root: string | null): string {
    if (!root) throw new Error('Open a project to manage its prompts')
    return root
  }

  return {
    load: (projectPath) => snapshot(projectPath),

    saveGlobal: (projectPath, prompts) =>
      enqueue(async () => {
        const user = await readUser()
        await writeJson(userFile(), { ...user, global: sanitizePrompts(prompts) })
        return snapshot(projectPath)
      }),

    saveProject: (projectPath, prompts) =>
      enqueue(async () => {
        const root = requireRoot(await rootOf(projectPath))
        // Activation is per machine, so the shared file never carries it.
        const clean = sanitizePrompts(prompts).map(({ id, name, body, updatedAt }) => ({ id, name, body, updatedAt }))
        await writeJson(projectFile(root), clean)
        return snapshot(projectPath)
      }),

    setProjectActive: (projectPath, ids) =>
      enqueue(async () => {
        const root = requireRoot(await rootOf(projectPath))
        const user = await readUser()
        const clean = sanitizeIds(ids)
        const projectActive = { ...user.projectActive }
        if (clean.length) projectActive[root] = clean
        else delete projectActive[root]
        await writeJson(userFile(), { ...user, projectActive })
        return snapshot(projectPath)
      }),

    activeBlock: async (checkout) => {
      try {
        const set = await snapshot(checkout)
        return activePromptBlock(set.global, set.project, set.activeProjectIds)
      } catch {
        return ''
      }
    }
  }
}
