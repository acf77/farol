import { shell } from 'electron'
import type { RemoteBilling, RemotePlan } from '../shared/settings'
import { billingLink, clearBillingLinks, setBillingLinks } from './billing-links'
import { serviceCall, session, SignInRequired } from './remote'
import { ServiceError } from './snapshot-sync'

const PLANS: readonly RemotePlan[] = ['free', 'trial', 'paid', 'key']

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** The signed-in user's plan. 404 means the service has billing off; 401 reads as signed out. */
export async function remoteBilling(): Promise<RemoteBilling> {
  try {
    const res = await serviceCall('/v1/billing', { signal: AbortSignal.timeout(15_000), token: session() })
    const body = (await res.json()) as Record<string, unknown>
    const plan = PLANS.find((p) => p === body.plan)
    if (!plan) return { state: 'error' }
    setBillingLinks({ upgrade: body.upgradeUrl, portal: body.portalUrl })
    return {
      state: 'ok',
      plan,
      freeSandboxesUsed: count(body.freeSandboxesUsed),
      freeSandboxesLimit: count(body.freeSandboxesLimit),
      canUpgrade: billingLink('upgrade') !== undefined,
      canManage: billingLink('portal') !== undefined,
      ...(typeof body.trialEndsAt === 'string' ? { trialEndsAt: body.trialEndsAt } : {})
    }
  } catch (err) {
    if (err instanceof SignInRequired) return { state: 'signedOut' }
    if (err instanceof ServiceError && err.status === 404) {
      clearBillingLinks()
      return { state: 'off' }
    }
    return { state: 'error' }
  }
}

/** Open the Stripe page in the system browser, with the URL exactly as the service sent it. */
export async function openBilling(kind: unknown): Promise<{ error?: string }> {
  const url = kind === 'upgrade' || kind === 'portal' ? billingLink(kind) : undefined
  if (!url) return { error: 'No billing link is available. Refresh and try again.' }
  try {
    await shell.openExternal(url)
    return {}
  } catch {
    return { error: 'Could not open the browser.' }
  }
}
