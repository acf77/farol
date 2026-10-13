/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RemoteBilling, RemotePlan } from '@shared/types'
import { remoteBilling } from '../remote-billing'
import { BillingButton } from './BillingButton'

function ok(plan: RemotePlan, links: { canUpgrade?: boolean; canManage?: boolean } = {}): RemoteBilling {
  return {
    state: 'ok',
    plan,
    freeSandboxesUsed: 1,
    freeSandboxesLimit: 3,
    canUpgrade: links.canUpgrade ?? true,
    canManage: links.canManage ?? true
  }
}

let billing: ReturnType<typeof vi.fn>
let openBilling: ReturnType<typeof vi.fn>
let paymentListener: ((e: { canUpgrade: boolean }) => void) | undefined
let stop: (() => void) | undefined

async function mount(reply: RemoteBilling | Promise<RemoteBilling>) {
  billing.mockReturnValue(Promise.resolve(reply))
  stop = remoteBilling.start()
  const view = render(<BillingButton />)
  await act(async () => {
    await Promise.resolve()
  })
  return view
}

beforeEach(() => {
  billing = vi.fn()
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
})

afterEach(() => {
  stop?.()
  stop = undefined
  cleanup()
  remoteBilling.reset()
})

describe('BillingButton', () => {
  it('shows Upgrade to a free user, and a click asks main to open the upgrade link', async () => {
    await mount(ok('free'))

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }))

    expect(openBilling).toHaveBeenCalledWith('upgrade')
  })

  it.each(['trial', 'paid'] as const)('shows Manage billing, not Upgrade, on %s', async (plan) => {
    await mount(ok(plan))

    expect(screen.queryByRole('button', { name: 'Upgrade' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Manage billing' }))
    expect(openBilling).toHaveBeenCalledWith('portal')
  })

  it('shows nothing to an API-key user', async () => {
    const { container } = await mount(ok('key'))
    expect(container.textContent).toBe('')
  })

  it('hides Upgrade when upgradeUrl is missing', async () => {
    const { container } = await mount(ok('free', { canUpgrade: false }))
    expect(container.textContent).toBe('')
  })

  it('hides the button when billing is off or the user is signed out', async () => {
    const off = await mount({ state: 'off' })
    expect(off.container.textContent).toBe('')
    cleanup()
    remoteBilling.reset()
    const out = await mount({ state: 'signedOut' })
    expect(out.container.textContent).toBe('')
  })

  it('is disabled with a spinner while the link loads', async () => {
    await mount(ok('free'))
    expect((screen.getByRole('button', { name: 'Upgrade' }) as HTMLButtonElement).disabled).toBe(false)

    let release!: (b: RemoteBilling) => void
    billing.mockReturnValue(new Promise<RemoteBilling>((resolve) => (release = resolve)))
    act(() => remoteBilling.refresh())

    const button = screen.getByRole('button', { name: 'Upgrade' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.querySelector('svg')).not.toBeNull()

    await act(async () => {
      release(ok('free'))
      await Promise.resolve()
    })
    expect((screen.getByRole('button', { name: 'Upgrade' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows no button while the first lookup is still loading', async () => {
    const { container } = await mount(new Promise<RemoteBilling>(() => undefined))
    expect(container.textContent).toBe('')
  })

  it('shows Upgrade after a 402 even when the plan could not be read', async () => {
    await mount({ state: 'error' })
    expect(screen.queryByRole('button', { name: 'Upgrade' })).toBeNull()

    billing.mockReturnValue(Promise.resolve({ state: 'error' }))
    await act(async () => {
      paymentListener?.({ canUpgrade: true })
      await Promise.resolve()
    })

    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeTruthy()
  })

  it('does not offer Upgrade after a 402 with no upgrade link', async () => {
    await mount({ state: 'error' })
    await act(async () => {
      paymentListener?.({ canUpgrade: false })
      await Promise.resolve()
    })
    expect(screen.queryByRole('button', { name: 'Upgrade' })).toBeNull()
  })
})
