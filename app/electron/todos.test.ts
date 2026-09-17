import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeTodos } from '../shared/todos'
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
  vi.restoreAllMocks()
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

  it('notifies after persistence for saves, clears, and forgets', async () => {
    const checkout = path.join(dir, 'repo')
    const persisted: Promise<string>[] = []
    const notify = vi.fn(() => {
      persisted.push(fs.readFile(path.join(dir, 'todos.json'), 'utf8'))
    })
    store = createTodoStore(() => dir, notify)
    const todos = sanitizeTodos(['Ship it'])

    const saving = store.save(checkout, ['Ship it'])
    expect(notify).not.toHaveBeenCalled()
    await saving
    expect(notify).toHaveBeenLastCalledWith({ checkout, todos })
    expect(JSON.parse(await persisted[0])).toEqual({ [checkout]: todos })

    await store.save(checkout, [])
    expect(notify).toHaveBeenLastCalledWith({ checkout, todos: [] })
    expect(JSON.parse(await persisted[1])).toEqual({})

    await store.save(checkout, todos)
    await persisted[2]
    await store.forget(checkout)
    expect(notify).toHaveBeenCalledTimes(4)
    expect(notify).toHaveBeenLastCalledWith({ checkout, todos: [] })
    expect(JSON.parse(await persisted[3])).toEqual({})
  })

  it('does not notify when persistence fails and keeps the queue usable', async () => {
    const checkout = path.join(dir, 'repo')
    const notify = vi.fn()
    store = createTodoStore(() => dir, notify)
    await store.save(checkout, ['Original'])
    notify.mockClear()
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(new Error('Cannot persist'))

    await expect(store.save(checkout, ['Replacement'])).rejects.toThrow('Cannot persist')
    await expect(store.forget(checkout)).rejects.toThrow('Cannot persist')
    expect(notify).not.toHaveBeenCalled()
    expect(await store.load(checkout)).toEqual(sanitizeTodos(['Original']))

    rename.mockRestore()
    await store.save(checkout, ['Retry'])
    expect(notify).toHaveBeenCalledExactlyOnceWith({ checkout, todos: sanitizeTodos(['Retry']) })
  })

  it('rejects a stale expected list without persisting or notifying', async () => {
    const checkout = path.join(dir, 'repo')
    const notify = vi.fn()
    store = createTodoStore(() => dir, notify)
    await store.save(checkout, ['Original'])
    const previous = await store.load(checkout)
    await store.save(checkout, ['User edit'], previous)
    notify.mockClear()

    await expect(store.save(checkout, ['Agent edit'], previous)).rejects.toThrow('Todo list changed')
    expect(notify).not.toHaveBeenCalled()
    expect(await store.load(checkout)).toEqual(sanitizeTodos(['User edit']))
    await store.save(checkout, [], await store.load(checkout))
    expect(await store.load(checkout)).toEqual([])
  })

  it('checks expected inside the queue so only one concurrent replacement wins', async () => {
    const checkout = path.join(dir, 'repo')
    const notify = vi.fn()
    store = createTodoStore(() => dir, notify)
    const results = await Promise.allSettled([
      store.save(checkout, ['User edit'], []),
      store.save(checkout, ['Agent edit'], [])
    ])

    expect(results[0].status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: new Error('Todo list changed. Reload it before saving again.') })
    expect(notify).toHaveBeenCalledExactlyOnceWith({ checkout, todos: sanitizeTodos(['User edit']) })
    expect(await store.load(checkout)).toEqual(sanitizeTodos(['User edit']))
  })

  it('serializes concurrent writes and forgets without losing sibling checkouts', async () => {
    const checkout = path.join(dir, 'repo')
    const sibling = path.join(dir, 'repo-feature')
    const notify = vi.fn()
    store = createTodoStore(() => dir, notify)
    await Promise.all([
      store.save(checkout, ['First'], []),
      store.save(sibling, ['Sibling'], []),
      store.save(checkout, ['Second'], sanitizeTodos(['First'])),
      store.forget(checkout),
      store.save(checkout, ['Last'], [])
    ])

    expect(notify.mock.calls.map(([event]) => event)).toEqual([
      { checkout, todos: sanitizeTodos(['First']) },
      { checkout: sibling, todos: sanitizeTodos(['Sibling']) },
      { checkout, todos: sanitizeTodos(['Second']) },
      { checkout, todos: [] },
      { checkout, todos: sanitizeTodos(['Last']) }
    ])
    expect(await store.load(checkout)).toEqual(sanitizeTodos(['Last']))
    expect(await store.load(sibling)).toEqual(sanitizeTodos(['Sibling']))
  })

  it('does not overwrite corrupted storage while saving another checkout', async () => {
    const storage = path.join(dir, 'todos.json')
    await fs.writeFile(storage, 'not json')

    await expect(store.load(path.join(dir, 'repo'))).rejects.toThrow()
    await expect(store.save(path.join(dir, 'other'), ['retry'])).rejects.toThrow()
    await expect(fs.readFile(storage, 'utf8')).resolves.toBe('not json')
  })
})
