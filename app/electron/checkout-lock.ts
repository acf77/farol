import fs from 'fs'
import path from 'path'
import { isInside } from '../shared/worktree'

/** Folders being deleted. Nothing may start work inside one until it is unlocked. */
const locked = new Set<string>()

export const CHECKOUT_LOCKED = 'This checkout is being deleted.'

/** Resolve symlinks and `..` so two spellings of one folder compare equal. */
function canonical(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** True when `cwd` is `dir` or sits inside it, however either path is spelled. */
export function insideCheckout(dir: string, cwd: string): boolean {
  return isInside(canonical(dir), canonical(cwd))
}

/** Take the folder for deletion. Returns the key to release, or null when a delete holds it, a parent, or a folder inside it. */
export function lockCheckout(dir: string): string | null {
  const key = canonical(dir)
  for (const held of locked) if (isInside(held, key) || isInside(key, held)) return null
  locked.add(key)
  return key
}

export function unlockCheckout(key: string): void {
  locked.delete(key)
}

export function checkoutLocked(cwd: string): boolean {
  for (const dir of locked) if (insideCheckout(dir, cwd)) return true
  return false
}

/** Git commands in flight, so a delete can wait for them. */
const inflight = new Set<{ cwd: string }>()

/** Record `work` as running in `cwd` until it settles. */
export function trackWork<T>(cwd: string, work: Promise<T>): Promise<T> {
  const entry = { cwd }
  inflight.add(entry)
  const done = (): void => void inflight.delete(entry)
  work.then(done, done)
  return work
}

/** Wait until no tracked work runs inside `dir`. Resolves false when `timeoutMs` passes first. */
export async function awaitIdle(dir: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while ([...inflight].some((entry) => insideCheckout(dir, entry.cwd))) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

/** Wait for `work`, but at most `timeoutMs`. True when it finished first. */
export async function finishesWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)))
  const done = await Promise.race([work.then(() => true), late])
  clearTimeout(timer)
  return done
}
