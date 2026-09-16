import fs from 'fs/promises'
import path from 'path'
import { sanitizeTodos, type Todo, type TodoStore } from '../shared/todos'

/** Persisted in userData, keyed by checkout. `userDataDir` is a thunk so this can be built before Electron is ready. */
export function createTodoStore(userDataDir: () => string): TodoStore {
  let queue: Promise<unknown> = Promise.resolve()
  const file = (): string => path.join(userDataDir(), 'todos.json')

  async function readAll(): Promise<Record<string, Todo[]>> {
    try {
      const raw = JSON.parse(await fs.readFile(file(), 'utf8')) as unknown
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
      const all: Record<string, Todo[]> = {}
      for (const [checkout, value] of Object.entries(raw as Record<string, unknown>)) {
        const todos = sanitizeTodos(value)
        if (todos.length) all[checkout] = todos
      }
      return all
    } catch {
      return {}
    }
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
      await fs.mkdir(path.dirname(file()), { recursive: true })
      await fs.writeFile(file(), JSON.stringify(all, null, 2) + '\n', 'utf8')
    })
  }

  return {
    load: (checkout) => enqueue(async () => (await readAll())[path.resolve(checkout)] ?? []),
    save: (checkout, todos) => update(checkout, sanitizeTodos(todos)),
    forget: (checkout) => update(checkout, [])
  }
}
