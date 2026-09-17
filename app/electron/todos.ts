import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { sanitizeTodos, type Todo, type TodoStore } from '../shared/todos'

/** Persisted in userData, keyed by checkout. `userDataDir` is a thunk so this can be built before Electron is ready. */
export function createTodoStore(userDataDir: () => string): TodoStore {
  let queue: Promise<unknown> = Promise.resolve()
  const file = (): string => path.join(userDataDir(), 'todos.json')

  function isMissing(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT'
  }

  async function readAll(): Promise<Record<string, Todo[]>> {
    let raw: string
    try {
      raw = await fs.readFile(file(), 'utf8')
    } catch (error) {
      if (isMissing(error)) return {}
      throw error
    }

    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch (error) {
      throw new Error('Could not read the todo list', { cause: error })
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Todo list storage is invalid')
    }

    const all: Record<string, Todo[]> = {}
    for (const [checkout, todos] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeTodos(todos)
      if (sanitized.length) all[checkout] = sanitized
    }
    return all
  }

  /** Serialize work, but let a failed operation settle so later ones still run. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task)
    queue = result.then(
      () => {},
      () => {}
    )
    return result
  }

  function update(checkout: string, todos: Todo[]): Promise<void> {
    const key = path.resolve(checkout)
    return enqueue(async () => {
      const all = await readAll()
      if (todos.length) all[key] = todos
      else delete all[key]

      const target = file()
      const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
      try {
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(temp, JSON.stringify(all, null, 2) + '\n', 'utf8')
        await fs.rename(temp, target)
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {})
        throw error
      }
    })
  }

  return {
    load: (checkout) => enqueue(async () => (await readAll())[path.resolve(checkout)] ?? []),
    save: (checkout, todos) => update(checkout, sanitizeTodos(todos)),
    forget: (checkout) => update(checkout, [])
  }
}
