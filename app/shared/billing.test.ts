import { describe, expect, it } from 'vitest'
import { billingAction, isOpenableLink } from './billing'
import type { RemoteBilling, RemotePlan } from './settings'

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

describe('billingAction', () => {
  it('offers Upgrade to a free user', () => {
    expect(billingAction(ok('free'), null)).toBe('upgrade')
  })

  it('offers Manage billing, not Upgrade, on trial and paid', () => {
    expect(billingAction(ok('trial'), null)).toBe('manage')
    expect(billingAction(ok('paid'), null)).toBe('manage')
  })

  it('offers nothing to an API-key user, even after a 402', () => {
    expect(billingAction(ok('key'), null)).toBeNull()
    expect(billingAction(ok('key'), { canUpgrade: true })).toBeNull()
  })

  it('hides Upgrade when the service sent no upgradeUrl', () => {
    expect(billingAction(ok('free', { canUpgrade: false }), null)).toBeNull()
  })

  it('hides Manage billing when the service sent no portalUrl', () => {
    expect(billingAction(ok('paid', { canManage: false }), null)).toBeNull()
  })

  it('does not offer Upgrade to a paid user because of an old 402', () => {
    expect(billingAction(ok('paid', { canManage: false }), { canUpgrade: true })).toBeNull()
  })

  it('offers Upgrade after a 402 when billing could not be read, but only with a link', () => {
    expect(billingAction({ state: 'error' }, { canUpgrade: true })).toBe('upgrade')
    expect(billingAction({ state: 'error' }, { canUpgrade: false })).toBeNull()
    expect(billingAction(null, { canUpgrade: true })).toBe('upgrade')
  })

  it('offers nothing before the plan is known, when billing is off, or when signed out', () => {
    expect(billingAction(null, null)).toBeNull()
    expect(billingAction({ state: 'off' }, null)).toBeNull()
    expect(billingAction({ state: 'signedOut' }, null)).toBeNull()
  })
})

describe('isOpenableLink', () => {
  it('accepts https and rejects anything else', () => {
    expect(isOpenableLink('https://buy.stripe.com/test_x?client_reference_id=u1')).toBe(true)
    expect(isOpenableLink('http://buy.stripe.com/x')).toBe(false)
    expect(isOpenableLink('file:///etc/passwd')).toBe(false)
    expect(isOpenableLink('javascript:alert(1)')).toBe(false)
    expect(isOpenableLink('not a url')).toBe(false)
    expect(isOpenableLink(undefined)).toBe(false)
  })
})
