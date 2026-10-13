import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('./secrets', () => ({ peekSecret: () => 'secret-token', setSecret: vi.fn(), clearSecret: vi.fn() }))
vi.mock('./service-url', () => ({ SERVICE_URL: 'https://service.test' }))
vi.mock('./checkout-snapshot', () => ({}))
vi.mock('./snapshot-manifest', () => ({}))
vi.mock('./sandbox', () => ({}))

import { billingLink, clearBillingLinks } from './billing-links'
import { PaymentRequired, serviceCall } from './remote'
import { ServiceError } from './snapshot-sync'

const UPGRADE = 'https://buy.stripe.com/test_abc?client_reference_id=user_1'

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: status < 400, status, json: () => Promise.resolve(body) })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => clearBillingLinks())
afterEach(() => vi.unstubAllGlobals())

describe('serviceCall on 402', () => {
  it('throws PaymentRequired with the service message and keeps the upgradeUrl for the button', async () => {
    const fetchMock = stubFetch(402, { error: 'Free sandboxes used up.', upgradeUrl: UPGRADE })

    const err = await serviceCall('/v1/workspaces', { method: 'POST', token: 'secret-token' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PaymentRequired)
    expect(err).toBeInstanceOf(ServiceError)
    expect((err as PaymentRequired).message).toBe('Free sandboxes used up.')
    expect((err as PaymentRequired).message).not.toContain('stripe')
    expect(billingLink('upgrade')).toBe(UPGRADE)
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer secret-token' })
  })

  it('still reports a 402 that carries no upgradeUrl', async () => {
    stubFetch(402, { error: 'Payment required.' })
    await expect(serviceCall('/v1/runs', { method: 'POST', token: 'secret-token' })).rejects.toBeInstanceOf(PaymentRequired)
    expect(billingLink('upgrade')).toBeUndefined()
  })
})
