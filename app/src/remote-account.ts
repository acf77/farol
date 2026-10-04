import { useSyncExternalStore } from 'react'
import type { RemoteAccount } from '@shared/types'
import { errorMessage } from '@shared/jev'

/**
 * Who this machine is signed in to the remote pipeline service as, shared by the
 * header's account menu and the pipeline editor. Signing in from either opens the
 * account menu, which shows the GitHub code.
 */

export interface RemoteAccountState {
  /** null until the first lookup returns. */
  account: RemoteAccount | null
  /** The device-flow code to enter on GitHub, while a sign-in waits. */
  userCode: string | null
  busy: boolean
  error: string | null
  menuOpen: boolean
}

/** What a cancelled sign-in reports; not worth showing as an error. */
const CANCELLED = 'Sign-in cancelled.'

let state: RemoteAccountState = { account: null, userCode: null, busy: false, error: null, menuOpen: false }
const listeners = new Set<() => void>()

function set(patch: Partial<RemoteAccountState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

const api = () => window.farol.remote

export const remoteAccount = {
  refresh(): void {
    void api()
      .account()
      .then((account) => set({ account }), (err: unknown) => set({ error: errorMessage(err) }))
  },

  async signIn(): Promise<void> {
    if (state.busy) return set({ menuOpen: true })
    set({ error: null, busy: true, menuOpen: true })
    try {
      const start = await api().signInStart()
      if ('error' in start) return set({ error: start.error })
      set({ userCode: start.userCode })
      const { error } = await api().signInWait()
      set({ error: error && error !== CANCELLED ? error : null })
    } catch (err) {
      set({ error: errorMessage(err) })
    } finally {
      set({ userCode: null, busy: false })
      remoteAccount.refresh()
    }
  },

  cancelSignIn(): void {
    void api().signInCancel()
  },

  async signOut(): Promise<void> {
    set({ busy: true })
    try {
      await api().signOut()
    } finally {
      set({ busy: false, error: null })
      remoteAccount.refresh()
    }
  },

  setMenuOpen(menuOpen: boolean): void {
    if (menuOpen && !state.menuOpen) remoteAccount.refresh()
    set({ menuOpen })
  }
}

export function useRemoteAccount(): RemoteAccountState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state
  )
}
