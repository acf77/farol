import type { PendingMessage } from './types'

/**
 * The queued message each chat should send now, for every chat — not only the one
 * on screen. `prev` holds each pane's status at the last look.
 */
export function pendingDispatches(
  prev: ReadonlyMap<string, string>,
  panes: readonly { id: string; status: string; pending?: PendingMessage[] }[],
  live: ReadonlySet<string>
): { paneId: string; message: PendingMessage }[] {
  return panes.flatMap((pane) => {
    const message = nextPendingToSend(prev.get(pane.id), pane.status, live, pane.pending)
    return message ? [{ paneId: pane.id, message }] : []
  })
}

/** The queued message to send now: the first one, once a live run has completed. */
export function nextPendingToSend(
  prevStatus: string | undefined,
  status: string,
  live: ReadonlySet<string>,
  pending: PendingMessage[] | undefined
): PendingMessage | undefined {
  return prevStatus && live.has(prevStatus) && status === 'completed' ? pending?.[0] : undefined
}
