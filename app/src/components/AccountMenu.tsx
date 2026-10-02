import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, RemoteAccount, RemoteResult } from '@shared/types'
import { errorMessage } from '@shared/jev'
import { C, MONO, glass as G } from '../theme'
import { Button } from './controls'
import { UserIcon } from './icons'
import { CHROME_ROW } from './side-panel'

/**
 * The header's account avatar. Its popover shows who this machine is signed in
 * to the remote service as, or offers Sign in with GitHub when it is not.
 */

const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

/** What a cancelled sign-in reports; not worth showing as an error. */
const CANCELLED = 'Sign-in cancelled.'

const host = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function Avatar({ account, size }: { account: RemoteAccount | null; size: number }) {
  const signedIn = account?.state === 'signedIn' ? account : null
  if (signedIn?.avatar) {
    return <img src={signedIn.avatar} alt="" width={size} height={size} style={{ borderRadius: '50%', display: 'block' }} />
  }
  if (signedIn) {
    const initial = (signedIn.displayName || signedIn.login || '?').charAt(0).toUpperCase()
    return (
      <span
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          background: C.accent,
          color: C.accentInk,
          fontSize: Math.round(size * 0.45),
          fontWeight: 700
        }}
      >
        {initial}
      </span>
    )
  }
  return <UserIcon size={Math.round(size * 0.6)} />
}

export default function AccountMenu({
  liquid,
  settings,
  onAdoptSettings,
  onOpenSettings
}: {
  liquid?: boolean
  settings: AppSettings
  onAdoptSettings: (next: AppSettings) => void
  onOpenSettings: () => void
}) {
  const api = window.farol
  const [account, setAccount] = useState<RemoteAccount | null>(null)
  const [open, setOpen] = useState(false)
  const [userCode, setUserCode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void api.remote.account().then(setAccount, (err: unknown) => setError(errorMessage(err)))
  }, [api])

  // The service URL or stored token changed (here or in Settings): ask again who we are.
  const remoteUrl = settings.remote?.url
  const hasKey = settings.remote?.hasKey
  useEffect(refresh, [refresh, remoteUrl, hasKey])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const adopt = (result: RemoteResult): void => {
    onAdoptSettings(result.settings)
    setError(result.error && result.error !== CANCELLED ? result.error : null)
    refresh()
  }

  const signIn = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const start = await api.remote.signInStart()
      if ('error' in start) return setError(start.error)
      setUserCode(start.userCode)
      adopt(await api.remote.signInWait())
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setUserCode(null)
      setBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    setBusy(true)
    try {
      adopt(await api.remote.clearKey())
    } finally {
      setBusy(false)
    }
  }

  const signedIn = account?.state === 'signedIn' ? account : null
  const label = signedIn ? `Account: ${signedIn.login}` : 'Account: not signed in'

  return (
    <>
      <button
        type="button"
        className="bf-focus bf-icon-btn"
        onClick={() => {
          if (!open) refresh()
          setOpen((v) => !v)
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        style={{
          ...noDrag,
          width: 28,
          height: 28,
          padding: 0,
          borderRadius: '50%',
          border: `1px solid ${C.border}`,
          background: C.sidebar,
          color: C.text,
          display: 'grid',
          placeItems: 'center',
          cursor: 'pointer',
          position: 'relative'
        }}
      >
        <Avatar account={account} size={signedIn?.avatar ? 26 : 22} />
        {account?.state === 'error' && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              right: -1,
              top: -1,
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: C.red,
              border: `1.5px solid ${C.terminal}`
            }}
          />
        )}
      </button>

      {open && (
        <>
          <div aria-hidden onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div
            role="dialog"
            aria-label="Account"
            style={{
              ...noDrag,
              position: 'absolute',
              top: CHROME_ROW,
              right: 16,
              zIndex: 50,
              width: 268,
              background: liquid ? G.panel : C.sidebar,
              border: `1px solid ${C.border}`,
              borderRadius: 12,
              boxShadow: '0 18px 44px rgba(0,0,0,0.55)',
              padding: 12,
              fontSize: 12,
              color: C.text
            }}
          >
            {signedIn ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Avatar account={account} size={36} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {signedIn.kind === 'user' ? signedIn.displayName || signedIn.login : 'API key'}
                    </div>
                    <div style={{ color: C.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {signedIn.kind === 'user' ? `@${signedIn.login}` : signedIn.login}
                    </div>
                  </div>
                </div>
                <div style={{ color: C.faint, fontSize: 11, marginTop: 10 }}>
                  Remote pipelines run on <span style={{ fontFamily: MONO }}>{host(signedIn.serviceUrl)}</span>
                </div>
                <div role="separator" style={{ height: 1, background: C.border, margin: '10px -12px' }} />
                <Button variant="secondary" disabled={busy} onClick={() => void signOut()} style={{ width: '100%' }}>
                  Sign out
                </Button>
              </>
            ) : account?.state === 'unconfigured' ? (
              <>
                <div style={{ color: C.textSoft, lineHeight: 1.45 }}>
                  Add your Farol service URL in Settings to sign in and run pipelines remotely.
                </div>
                <Button
                  variant="primary"
                  onClick={() => {
                    setOpen(false)
                    onOpenSettings()
                  }}
                  style={{ width: '100%', marginTop: 10 }}
                >
                  Open Settings
                </Button>
              </>
            ) : account?.state === 'error' ? (
              <>
                <div style={{ color: C.textSoft, lineHeight: 1.45 }}>{account.message}</div>
                <div style={{ color: C.faint, fontSize: 11, marginTop: 6, fontFamily: MONO }}>{host(account.serviceUrl)}</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <Button variant="primary" disabled={busy} onClick={refresh} style={{ flex: 1 }}>
                    Try again
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={() => void signOut()} style={{ flex: 1 }}>
                    Sign out
                  </Button>
                </div>
              </>
            ) : userCode ? (
              <>
                <div style={{ color: C.textSoft, lineHeight: 1.45 }}>Enter this code on the GitHub page that opened:</div>
                <div
                  style={{
                    fontFamily: MONO,
                    fontSize: 18,
                    fontWeight: 600,
                    letterSpacing: 2,
                    textAlign: 'center',
                    margin: '10px 0',
                    userSelect: 'text'
                  }}
                >
                  {userCode}
                </div>
                <Button variant="secondary" onClick={() => void api.remote.signInCancel()} style={{ width: '100%' }}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <div style={{ color: C.textSoft, lineHeight: 1.45 }}>
                  {(account?.state === 'signedOut' && account.message) || 'Sign in to run pipelines remotely.'}
                </div>
                {account && (
                  <div style={{ color: C.faint, fontSize: 11, marginTop: 6, fontFamily: MONO }}>{host(account.serviceUrl)}</div>
                )}
                <Button variant="primary" disabled={busy} onClick={() => void signIn()} style={{ width: '100%', marginTop: 10 }}>
                  Sign in with GitHub
                </Button>
              </>
            )}
            {error && <div style={{ color: C.red, marginTop: 8, lineHeight: 1.45 }}>{error}</div>}
          </div>
        </>
      )}
    </>
  )
}
