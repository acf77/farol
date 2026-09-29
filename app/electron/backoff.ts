/**
 * Delay before a same-model retry or a fallback switch. Rate limits and
 * flaky exits often clear within a few seconds — retrying instantly just
 * hammers a provider that already said "slow down".
 */
const BASE_MS = 1_000
const MAX_MS = 20_000

export function backoffDelayMs(attempt: number): number {
  return Math.min(MAX_MS, BASE_MS * 2 ** Math.max(0, attempt - 1))
}

/** Resolves early if `signal` aborts (task cancelled) instead of waiting out the delay. */
export function backoffWait(attempt: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, backoffDelayMs(attempt))
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}
