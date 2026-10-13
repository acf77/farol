import { useSyncExternalStore } from 'react'
import type { RemoteBilling } from '@shared/types'
import { PLAN_RETRIES, PLAN_RETRY_MS } from '@shared/billing'

/**
 * The signed-in user's plan, shared by the account popover and the pipeline editor.
 * The Stripe links stay in the main process; this only asks for them to be opened.
 *
 * After an Upgrade click the plan is re-read when the window gets focus back, and
 * a few times more while Stripe catches up with the payment.
 */

export interface RemoteBillingState {
  /** null until the first lookup returns. */
  billing: RemoteBilling | null
  /** A lookup is in flight; the buttons wait for it. */
  loading: boolean
  /** The service answered a run or workspace call with 402. */
  paymentRequired: { canUpgrade: boolean } | null
  /** Upgrade was clicked and the plan still reads free after every retry. */
  notSeen: boolean
  error: string | null
}

const initial: RemoteBillingState = { billing: null, loading: false, paymentRequired: null, notSeen: false, error: null }

let state = initial
const listeners = new Set<() => void>()
/** Set by an Upgrade click; cleared once the plan changes or the retries run out. */
let watching = false
let retryTimer: ReturnType<typeof setTimeout> | undefined
let lookups = 0

function set(patch: Partial<RemoteBillingState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

const api = () => window.farol.remote

function stopRetrying(): void {
  clearTimeout(retryTimer)
  retryTimer = undefined
}

/** One lookup. A newer lookup wins over an older one still in flight. */
async function lookup(): Promise<RemoteBilling | null> {
  const mine = ++lookups
  set({ loading: true })
  try {
    const billing = await api().billing()
    if (mine !== lookups) return null
    // 'free' is the only plan the Upgrade button is for: any other plan ends the wait.
    const changed = billing.state === 'ok' && billing.plan !== 'free'
    if (changed) {
      watching = false
      stopRetrying()
    }
    set({
      billing,
      loading: false,
      error: null,
      ...(changed ? { notSeen: false, paymentRequired: null } : {}),
      ...(billing.state === 'signedOut' ? { paymentRequired: null, notSeen: false } : {})
    })
    return billing
  } catch {
    if (mine !== lookups) return null
    set({ loading: false, error: 'Cannot read your plan. Try again.' })
    return null
  }
}

/** Look up the plan, then, while an upgrade is awaited, again every PLAN_RETRY_MS up to `retries` more times. */
async function lookupWhileWatching(retries: number): Promise<void> {
  stopRetrying()
  const billing = await lookup()
  if (!watching || billing === null) return
  if (billing.state === 'ok' && billing.plan === 'free') {
    if (retries <= 0) {
      watching = false
      set({ notSeen: true })
      return
    }
    retryTimer = setTimeout(() => void lookupWhileWatching(retries - 1), PLAN_RETRY_MS)
  } else {
    watching = false
  }
}

export const remoteBilling = {
  refresh(): void {
    void lookup()
  },

  /** The Refresh button of "Payment not seen yet": look again, with a fresh set of retries. */
  recheck(): void {
    set({ notSeen: false })
    watching = true
    void lookupWhileWatching(PLAN_RETRIES)
  },

  async open(kind: 'upgrade' | 'portal'): Promise<void> {
    set({ error: null })
    try {
      const { error } = await api().openBilling(kind)
      if (error) return set({ error })
      if (kind === 'upgrade') {
        watching = true
        set({ notSeen: false })
      }
    } catch {
      set({ error: 'Could not open the browser.' })
    }
  },

  /** The app window got focus again: the user may be back from Stripe. */
  onFocus(): void {
    if (state.billing === null || state.billing.state === 'signedOut') return
    if (watching) void lookupWhileWatching(PLAN_RETRIES)
    else void lookup()
  },

  /** Start listening for focus and 402s; returns the way to stop. */
  start(): () => void {
    const onFocus = (): void => remoteBilling.onFocus()
    window.addEventListener('focus', onFocus)
    const offPayment = api().onPaymentRequired((paymentRequired) => {
      set({ paymentRequired })
      void lookup()
    })
    void lookup()
    return () => {
      window.removeEventListener('focus', onFocus)
      offPayment()
      stopRetrying()
    }
  },

  /** Back to the start; for tests and sign-out. */
  reset(): void {
    stopRetrying()
    watching = false
    lookups++
    set({ ...initial })
  }
}

export function useRemoteBilling(): RemoteBillingState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state
  )
}
