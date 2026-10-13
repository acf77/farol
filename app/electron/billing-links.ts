import { isOpenableLink } from '../shared/billing'

/**
 * The Stripe links the service last sent, kept in memory only and never logged.
 * They stay in the main process: the renderer asks to open one, it never holds one.
 * The URL is used exactly as given, because its client_reference_id is how the
 * service finds the user after payment.
 */
const links: { upgrade?: string; portal?: string } = {}
const listeners = new Set<(e: { canUpgrade: boolean }) => void>()

export function setBillingLinks(next: { upgrade?: unknown; portal?: unknown }): void {
  links.upgrade = isOpenableLink(next.upgrade) ? next.upgrade : undefined
  links.portal = isOpenableLink(next.portal) ? next.portal : undefined
}

export function billingLink(kind: 'upgrade' | 'portal'): string | undefined {
  return links[kind]
}

export function clearBillingLinks(): void {
  setBillingLinks({})
}

/** A 402 reply: remember its upgrade link, when it has one, and tell whoever listens. */
export function notePaymentRequired(upgradeUrl: unknown): void {
  if (isOpenableLink(upgradeUrl)) links.upgrade = upgradeUrl
  for (const listener of listeners) listener({ canUpgrade: links.upgrade !== undefined })
}

export function onPaymentRequired(cb: (e: { canUpgrade: boolean }) => void): void {
  listeners.add(cb)
}
