/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteBilling, RemotePlan } from '@shared/types'
import { remoteBilling } from './remote-billing'

const free = ok('free')

function ok(plan: RemotePlan): RemoteBilling {
  return { state: 'ok', plan, freeSandboxesUsed: 3, freeSandboxesLimit: 3, canUpgrade: true, canManage: true }
}

let billing: ReturnType<typeof vi.fn>
let openBilling: ReturnType<typeof vi.fn>
let paymentListener: ((e: { canUpgrade: boolean }) => void) | undefined
let stop: () => void

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** The store's own view, read through a subscription-free peek. */
async function snapshot() {
  const { useRemoteBilling } = await import('./remote-billing')
  const { renderHook } = await import('@testing-library/react')
  const hook = renderHook(() => useRemoteBilling())
  const state = hook.result.current
  hook.unmount()
  return state
}

beforeEach(() => {
  vi.useFakeTimers()
  billing = vi.fn().mockResolvedValue(free)
  openBilling = vi.fn().mockResolvedValue({})
  paymentListener = undefined
  ;(window as unknown as { farol: unknown }).farol = {
    remote: {
      billing,
      openBilling,
      onPaymentRequired: (cb: typeof paymentListener) => {
        paymentListener = cb
        return () => undefined
      }
    }
  }
  remoteBilling.reset()
  stop = remoteBilling.start()
})

afterEach(() => {
  stop()
  remoteBilling.reset()
  vi.useRealTimers()
})

describe('remoteBilling', () => {
  it('reads the plan on start', async () => {
    await settle()
    expect((await snapshot()).billing).toEqual(free)
  })

  it('opens the upgrade link through the main process on click', async () => {
    await settle()
    await remoteBilling.open('upgrade')
    expect(openBilling).toHaveBeenCalledWith('upgrade')
  })

  it('does not wait for a payment after Manage billing', async () => {
    await settle()
    await remoteBilling.open('portal')
    billing.mockClear()
    window.dispatchEvent(new Event('focus'))
    await settle(20_000)
    expect(billing).toHaveBeenCalledTimes(1)
  })

  it('looks the plan up once when the window gets focus, without an upgrade click', async () => {
    await settle()
    billing.mockClear()
    window.dispatchEvent(new Event('focus'))
    await settle(20_000)
    expect(billing).toHaveBeenCalledTimes(1)
  })

  it('after an upgrade click, retries on focus until the plan is not free', async () => {
    await settle()
    await remoteBilling.open('upgrade')
    billing.mockClear()
    billing.mockResolvedValueOnce(free).mockResolvedValueOnce(free).mockResolvedValue(ok('paid'))

    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(billing).toHaveBeenCalledTimes(1)
    await settle(3000)
    expect(billing).toHaveBeenCalledTimes(2)
    await settle(3000)
    expect(billing).toHaveBeenCalledTimes(3)

    const state = await snapshot()
    expect(state.billing).toMatchObject({ plan: 'paid' })
    expect(state.notSeen).toBe(false)
    await settle(30_000)
    expect(billing).toHaveBeenCalledTimes(3)
  })

  it('retries 5 times, 3 seconds apart, then reports the payment as not seen', async () => {
    await settle()
    await remoteBilling.open('upgrade')
    billing.mockClear()

    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(billing).toHaveBeenCalledTimes(1)
    for (let retry = 1; retry <= 5; retry++) {
      await settle(2999)
      expect(billing).toHaveBeenCalledTimes(retry)
      await settle(1)
      expect(billing).toHaveBeenCalledTimes(retry + 1)
    }
    await settle(30_000)
    expect(billing).toHaveBeenCalledTimes(6)
    expect((await snapshot()).notSeen).toBe(true)
  })

  it('Refresh looks again, and clears the message once the plan changed', async () => {
    await settle()
    await remoteBilling.open('upgrade')
    window.dispatchEvent(new Event('focus'))
    await settle(20_000)
    expect((await snapshot()).notSeen).toBe(true)

    billing.mockResolvedValue(ok('paid'))
    remoteBilling.recheck()
    await settle()

    const state = await snapshot()
    expect(state.notSeen).toBe(false)
    expect(state.billing).toMatchObject({ plan: 'paid' })
  })

  it('remembers a 402 and re-reads the plan', async () => {
    await settle()
    billing.mockClear()
    paymentListener?.({ canUpgrade: true })
    await settle()

    expect((await snapshot()).paymentRequired).toEqual({ canUpgrade: true })
    expect(billing).toHaveBeenCalledTimes(1)
  })

  it('clears the 402 once the plan is no longer free', async () => {
    await settle()
    billing.mockResolvedValue(ok('paid'))
    paymentListener?.({ canUpgrade: true })
    await settle()

    expect((await snapshot()).paymentRequired).toBeNull()
  })

  it('shows an error, not a stale plan, when the lookup fails', async () => {
    await settle()
    billing.mockRejectedValue(new Error('ipc'))
    remoteBilling.refresh()
    await settle()
    expect((await snapshot()).error).toBeTruthy()
  })
})
