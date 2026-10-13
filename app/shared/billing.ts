import type { RemoteBilling } from './settings'

/** Which billing button the user gets, if any. */
export type BillingAction = 'upgrade' | 'manage'

/**
 * Upgrade only for the free plan, or after the service answered 402; trial and paid
 * manage billing instead, and API-key users get neither. A link that did not come
 * from the service is never built here, so no link means no button.
 */
export function billingAction(billing: RemoteBilling | null, paymentRequired: { canUpgrade: boolean } | null): BillingAction | null {
  if (billing?.state === 'ok') {
    if (billing.plan === 'trial' || billing.plan === 'paid') return billing.canManage ? 'manage' : null
    if (billing.plan === 'key') return null
    return billing.canUpgrade ? 'upgrade' : null
  }
  return paymentRequired?.canUpgrade ? 'upgrade' : null
}

export const PLAN_LABEL = { free: 'Free', trial: 'Trial', paid: 'Paid', key: 'API key' } as const

export const PAYMENT_NOT_SEEN = 'Payment not seen yet. Try again in a minute.'

/** After an upgrade click: how often and how many times to look for the new plan. */
export const PLAN_RETRIES = 5
export const PLAN_RETRY_MS = 3000

/** A link the app may hand to the browser: https only, and passed on untouched. */
export function isOpenableLink(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}
