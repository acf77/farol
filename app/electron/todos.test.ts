import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createTodoStore } from './todos'

let dir: string
let store: ReturnType<typeof createTodoStore>

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'farol-todos-'))
  store = createTodoStore(() => dir)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('createTodoStore', () => {
  it('round-trips a checkout list across store instances', async () => {
    const checkout = path.join(dir, 'repo')
    await store.save(checkout, [{ content: 'Ship it', status: 'pending', priority: 'high' }])
    expect(await createTodoStore(() => dir).load(checkout)).toEqual([
      { content: 'Ship it', status: 'pending', priority: 'high' }
    ])
  })

  it('isolates checkouts of the same repo', async () => {
    const main = path.join(dir, 'repo')
    const worktree = path.join(dir, 'repo-feature')
    await store.save(main, ['main work'])
    await store.save(worktree, ['branch work'])
    expect((await store.load(main)).map((todo) => todo.content)).toEqual(['main work'])
    expect((await store.load(worktree)).map((todo) => todo.content)).toEqual(['branch work'])
  })

  it('forgets a checkout without touching its siblings', async () => {
    const main = path.join(dir, 'repo')
    const worktree = path.join(dir, 'repo-feature')
    await store.save(main, ['main work'])
    await store.save(worktree, ['branch work'])
    await store.forget(worktree)
    expect(await store.load(worktree)).toEqual([])
    expect((await store.load(main)).map((todo) => todo.content)).toEqual(['main work'])
  })

  it('is empty for an unknown checkout or a missing file', async () => {
    expect(await store.load(path.join(dir, 'never-seen'))).toEqual([])
  })

  it('clears a checkout on an empty save', async () => {
    const checkout = path.join(dir, 'repo')
    await store.save(checkout, ['a'])
    await store.save(checkout, [])
    expect(await store.load(checkout)).toEqual([])
  })

  it('recovers the queue after a failed save so later operations still run', async () => {
    const blocker = path.join(dir, 'blocker')
    await fs.writeFile(blocker, 'not a directory')
    const failing = createTodoStore(() => path.join(blocker, 'nested'))

    await expect(failing.save('/repo', ['first'])).rejects.toThrow()

    await fs.rm(blocker)
    await failing.save('/repo', ['retry'])
    expect((await failing.load('/repo')).map((todo) => todo.content)).toEqual(['retry'])
  })
})
