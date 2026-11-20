/** Per-checkout serialization shared by the Git panel and agents. */

const tails = new Map<string, Promise<void>>()

/** Run `task` after prior tasks with the same `key` finish. */
export function inTurn<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).then(task)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return run
}
