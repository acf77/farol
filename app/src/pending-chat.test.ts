import { describe, expect, it } from 'vitest'
import { AGENT_LIVE } from '@shared/types'
import { nextPendingToSend, pendingDispatches } from './pending-chat'
import type { PendingMessage } from './types'

const a: PendingMessage = { id: 'a', text: 'one', provider: 'claude', mode: 'build' }
const b: PendingMessage = { id: 'b', text: 'two', provider: 'claude', mode: 'build' }

describe('nextPendingToSend', () => {
  it('sends the first queued message when a live run completes', () => {
    expect(nextPendingToSend('working', 'completed', AGENT_LIVE, [a, b])).toBe(a)
    expect(nextPendingToSend('validating', 'completed', AGENT_LIVE, [a])).toBe(a)
  })

  it('keeps the queue for cancelled, failed or asking runs', () => {
    for (const status of ['cancelled', 'failed', 'asking', 'needs-attention']) {
      expect(nextPendingToSend('working', status, AGENT_LIVE, [a])).toBeUndefined()
    }
  })

  it('does nothing without a live run before or without a queue', () => {
    expect(nextPendingToSend('idle', 'completed', AGENT_LIVE, [a])).toBeUndefined()
    expect(nextPendingToSend(undefined, 'completed', AGENT_LIVE, [a])).toBeUndefined()
    expect(nextPendingToSend('working', 'completed', AGENT_LIVE, [])).toBeUndefined()
    expect(nextPendingToSend('working', 'completed', AGENT_LIVE, undefined)).toBeUndefined()
  })
})

describe('pendingDispatches', () => {
  it('sends for a chat that finished while another chat was on screen', () => {
    const prev = new Map([
      ['shown', 'working'],
      ['hidden', 'working']
    ])
    const panes = [
      { id: 'shown', status: 'working', pending: [b] },
      { id: 'hidden', status: 'completed', pending: [a, b] }
    ]
    expect(pendingDispatches(prev, panes, AGENT_LIVE)).toEqual([{ paneId: 'hidden', message: a }])
  })

  it('sends nothing for a pane it has not seen run', () => {
    expect(pendingDispatches(new Map(), [{ id: 'p', status: 'completed', pending: [a] }], AGENT_LIVE)).toEqual([])
  })
})
