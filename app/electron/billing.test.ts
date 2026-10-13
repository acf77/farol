import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternal, serviceCall } = vi.hoisted(() => ({ openExternal: vi.fn(), serviceCall: vi.fn() }))

vi.mock('electron', () => ({ shell: { openExternal } }))
vi.mock('./remote', () => ({
  serviceCall,
  session: () => 'secret-token',
  SignInRequired: class SignInRequired extends Error {}
}))

import { openBilling, remoteBilling } from './billing'
import { clearBillingLinks, notePaymentRequired, onPaymentRequired } from './billing-links'
import { SignInRequired } from './remote'
import { ServiceError } from './snapshot-sync'

const UPGRADE = 'https://buy.stripe.com/test_abc?client_reference_id=user_1&prefilled_email=a%2Bb%40x.com'
const PORTAL = 'https://billing.stripe.com/p/session/test_xyz'

function reply(body: unknown) {
  serviceCall.mockResolvedValue({ json: () => Promise.resolve(body) })
}

beforeEach(() => {
  vi.clearAllMocks()
  clearBillingLinks()
})

describe('remoteBilling', () => {
  it.each(['free', 'trial', 'paid', 'key'] as const)('reads the %s plan with the Bearer session', async (plan) => {
    reply({ plan, freeSandboxesUsed: 2, freeSandboxesLimit: 3, upgradeUrl: UPGRADE, portalUrl: PORTAL, trialEndsAt: '2026-11-01T00:00:00Z' })

    const billing = await remoteBilling()

    expect(serviceCall).toHaveBeenCalledWith('/v1/billing', expect.objectContaining({ token: 'secret-token' }))
    expect(billing).toEqual({
      state: 'ok',
      plan,
      freeSandboxesUsed: 2,
      freeSandboxesLimit: 3,
      canUpgrade: true,
      canManage: true,
      trialEndsAt: '2026-11-01T00:00:00Z'
    })
  })

  it('never hands the Stripe links to the renderer', async () => {
    reply({ plan: 'free', freeSandboxesUsed: 0, freeSandboxesLimit: 3, upgradeUrl: UPGRADE, portalUrl: PORTAL })
    expect(JSON.stringify(await remoteBilling())).not.toContain('stripe.com')
  })

  it('reports no upgrade when upgradeUrl is missing', async () => {
    reply({ plan: 'free', freeSandboxesUsed: 0, freeSandboxesLimit: 3 })
    expect(await remoteBilling()).toMatchObject({ plan: 'free', canUpgrade: false, canManage: false })
    expect(await openBilling('upgrade')).toEqual({ error: expect.any(String) })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('maps 404 to billing off and 401 to signed out', async () => {
    serviceCall.mockRejectedValueOnce(new ServiceError('nope', 404))
    expect(await remoteBilling()).toEqual({ state: 'off' })
    serviceCall.mockRejectedValueOnce(new SignInRequired())
    expect(await remoteBilling()).toEqual({ state: 'signedOut' })
  })

  it('treats an unknown plan or a network failure as an error', async () => {
    reply({ plan: 'platinum' })
    expect(await remoteBilling()).toEqual({ state: 'error' })
    serviceCall.mockRejectedValueOnce(new Error('offline'))
    expect(await remoteBilling()).toEqual({ state: 'error' })
  })

  it('forgets stale links when the service turns billing off', async () => {
    reply({ plan: 'free', freeSandboxesUsed: 0, freeSandboxesLimit: 3, upgradeUrl: UPGRADE })
    await remoteBilling()
    serviceCall.mockRejectedValueOnce(new ServiceError('nope', 404))
    await remoteBilling()
    expect(await openBilling('upgrade')).toEqual({ error: expect.any(String) })
  })
})

describe('openBilling', () => {
  it('opens the upgrade URL byte for byte, in the system browser', async () => {
    reply({ plan: 'free', freeSandboxesUsed: 0, freeSandboxesLimit: 3, upgradeUrl: UPGRADE, portalUrl: PORTAL })
    await remoteBilling()

    expect(await openBilling('upgrade')).toEqual({})
    expect(openExternal).toHaveBeenCalledWith(UPGRADE)
  })

  it('opens the portal URL for Manage billing', async () => {
    reply({ plan: 'paid', freeSandboxesUsed: 0, freeSandboxesLimit: 3, portalUrl: PORTAL })
    await remoteBilling()

    await openBilling('portal')
    expect(openExternal).toHaveBeenCalledWith(PORTAL)
  })

  it('refuses a link that is not https, and any other kind', async () => {
    reply({ plan: 'free', freeSandboxesUsed: 0, freeSandboxesLimit: 3, upgradeUrl: 'file:///etc/passwd' })
    await remoteBilling()

    expect(await openBilling('upgrade')).toEqual({ error: expect.any(String) })
    expect(await openBilling('anything')).toEqual({ error: expect.any(String) })
    expect(openExternal).not.toHaveBeenCalled()
  })
})

describe('a 402 reply', () => {
  it('remembers its upgradeUrl and tells listeners whether there is one', async () => {
    const seen: boolean[] = []
    onPaymentRequired((e) => seen.push(e.canUpgrade))

    notePaymentRequired(undefined)
    notePaymentRequired(UPGRADE)

    expect(seen).toEqual([false, true])
    await openBilling('upgrade')
    expect(openExternal).toHaveBeenCalledWith(UPGRADE)
  })
})
