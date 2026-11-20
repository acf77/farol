/**
 * One queue per key (a checkout), so work that must not overlap waits its turn. This state is
 * shared by every caller on purpose: the Git panel and agents reach the same checkout from
 * different places, and only a shared queue can keep them apart.
 */

/** The last task queued for each key. An entry goes when its task is the last one and has ended. */
const tails = new Map<string, Promise<void>>()

/**
 * Run `task` after every earlier task with the same `key` has ended, whether it succeeded or
 * failed. Tasks with other keys do not wait. The result, or the error, is the task's own.
 */
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
