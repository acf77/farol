import type { RunResult } from './run-result'

/**
 * Client rules for the run service's AI fallback. Pure: the caller does the fetch, reads the
 * SSE stream and runs steps with the local agent. After a 402 the caller must not retry or
 * call the remote again for that run.
 */

/** The SSE `end` event. `failedNodeId` can name a `needs-local` step, so judge failure by step status. */
export interface RunEnd {
  ok: boolean
  cancelled?: boolean
  failedNodeId?: string
  localNodeIds?: string[]
}

/** A create-run refusal (402 or 422) that says to run the whole pipeline locally; else null (old servers). */
export function createFallback(status: number, body: { fallback?: string; topupUrl?: string }): { topupUrl?: string } | null {
  if ((status !== 402 && status !== 422) || body.fallback !== 'local') return null
  return body.topupUrl ? { topupUrl: body.topupUrl } : {}
}

/** The one line to print for an `ai-fallback` event; null for any other event. */
export function fallbackLine(event: string, data: { nodeId?: string }): string | null {
  return event === 'ai-fallback' && data.nodeId ? `Credits ended. Step ${data.nodeId} will run locally.` : null
}

/** Returns the top-up URL on the first call that has one, then null: print it once per run. */
export function topupOnce(): (url?: string) => string | null {
  let shown = false
  return (url) => {
    if (!url || shown) return null
    shown = true
    return url
  }
}

/**
 * Node ids to run locally, in order: `end.localNodeIds` (or the `needs-local` steps when the
 * stream had no `end`), then the pending or skipped steps after the first `needs-local` step.
 */
export function localSteps(end: RunEnd | undefined, result: RunResult): string[] {
  const { steps } = result
  const first = steps.findIndex((s) => s.status === 'needs-local')
  if (first < 0) return end?.localNodeIds ?? []
  const ids = end?.localNodeIds ?? steps.filter((s) => s.status === 'needs-local').map((s) => s.id)
  const later = steps.slice(first + 1).filter((s) => (s.status === 'pending' || s.status === 'skipped') && !ids.includes(s.id))
  return [...ids, ...later.map((s) => s.id)]
}

/** The remote part passed: no failed step, no run error, not cancelled. `needs-local` is not a failure. */
export function remotePassed(end: RunEnd | undefined, result: RunResult): boolean {
  const cancelled = end?.cancelled || result.status === 'cancelled'
  return !cancelled && !result.error && !result.steps.some((s) => s.status === 'failed')
}

/** 0 only when the remote part and every local step passed. */
export function exitCode(remoteOk: boolean, localOks: boolean[]): 0 | 1 {
  return remoteOk && localOks.every(Boolean) ? 0 : 1
}
