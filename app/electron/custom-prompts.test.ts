import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createCustomPromptStore } from './custom-prompts'

let dir: string
let userData: string
let repo: string
let worktree: string
let store: ReturnType<typeof createCustomPromptStore>

/** Linked worktrees resolve to the primary checkout, like `pipelineStoreRootFor`. */
const rootFor = async (projectPath: string): Promise<string> => (projectPath === worktree ? repo : projectPath)

function prompt(id: string, body: string, active = false) {
  return { id, name: id, body, active, updatedAt: 1 }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'farol-prompts-'))
  userData = path.join(dir, 'userData')
  repo = path.join(dir, 'repo')
  worktree = path.join(dir, 'repo-feature')
  store = createCustomPromptStore(() => userData, rootFor)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('createCustomPromptStore', () => {
  it('loads empty when nothing is stored', async () => {
    expect(await store.load(repo)).toEqual({ global: [], project: [], activeProjectIds: [], projectRoot: repo })
    expect(await store.load(null)).toEqual({ global: [], project: [], activeProjectIds: [], projectRoot: null })
  })

  it('round-trips global prompts across store instances', async () => {
    await store.saveGlobal(null, [prompt('terse', 'Be terse.', true)])
    const again = createCustomPromptStore(() => userData, rootFor)
    expect((await again.load(repo)).global).toEqual([prompt('terse', 'Be terse.', true)])
  })

  it('writes project prompts to .farol/prompts.json without an active flag', async () => {
    await store.saveProject(repo, [prompt('tests', 'Use vitest.', true)])
    const file = JSON.parse(await fs.readFile(path.join(repo, '.farol', 'prompts.json'), 'utf8'))
    expect(file).toEqual([{ id: 'tests', name: 'tests', body: 'Use vitest.', updatedAt: 1 }])
  })

  it('starts project prompts off, even when the repo file says active', async () => {
    await fs.mkdir(path.join(repo, '.farol'), { recursive: true })
    await fs.writeFile(path.join(repo, '.farol', 'prompts.json'), JSON.stringify([prompt('x', 'Do x.', true)]))
    const set = await store.load(repo)
    expect(set.project.map((p) => p.id)).toEqual(['x'])
    expect(set.activeProjectIds).toEqual([])
    expect(await store.activeBlock(repo)).toBe('')
  })

  it('keeps project activation per machine and drops ids no longer in the file', async () => {
    await store.saveProject(repo, [prompt('a', 'A.'), prompt('b', 'B.')])
    await store.setProjectActive(repo, ['b', 'b', 'gone'])
    expect((await store.load(repo)).activeProjectIds).toEqual(['b'])
    const stored = JSON.parse(await fs.readFile(path.join(userData, 'custom-prompts.json'), 'utf8'))
    expect(stored.projectActive).toEqual({ [repo]: ['b', 'gone'] })
  })

  it('shares one project file and activation between worktrees', async () => {
    await store.saveProject(worktree, [prompt('a', 'A.')])
    await store.setProjectActive(worktree, ['a'])
    const set = await store.load(repo)
    expect(set.projectRoot).toBe(repo)
    expect(set.activeProjectIds).toEqual(['a'])
  })

  it('builds the active block from global and switched-on project prompts', async () => {
    await store.saveGlobal(repo, [prompt('g', 'Global rule.', true), prompt('off', 'Hidden.')])
    await store.saveProject(repo, [prompt('p', 'Project rule.'), prompt('q', 'Not on.')])
    await store.setProjectActive(repo, ['p'])
    expect(await store.activeBlock(worktree)).toBe(
      '<custom_instructions>\n### g\nGlobal rule.\n\n### p\nProject rule.\n</custom_instructions>'
    )
  })

  it('loads a corrupt file as empty but refuses to overwrite it', async () => {
    await fs.mkdir(userData, { recursive: true })
    await fs.writeFile(path.join(userData, 'custom-prompts.json'), '{ not json')
    expect((await store.load(null)).global).toEqual([])
    expect(await store.activeBlock(repo)).toBe('')
    await expect(store.saveGlobal(null, [prompt('a', 'A.')])).rejects.toThrow('Could not read custom-prompts.json')
    expect(await fs.readFile(path.join(userData, 'custom-prompts.json'), 'utf8')).toBe('{ not json')
  })

  it('needs a project for project mutations', async () => {
    await expect(store.saveProject('', [])).rejects.toThrow('Open a project')
    await expect(store.setProjectActive('  ', [])).rejects.toThrow('Open a project')
  })

  it('serializes concurrent writes so none is lost', async () => {
    await store.saveProject(repo, [prompt('p', 'P.')])
    await Promise.all([store.saveGlobal(null, [prompt('g', 'G.', true)]), store.setProjectActive(repo, ['p'])])
    const set = await store.load(repo)
    expect(set.global.map((p) => p.id)).toEqual(['g'])
    expect(set.activeProjectIds).toEqual(['p'])
  })
})
