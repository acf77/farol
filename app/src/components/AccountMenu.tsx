import { useEffect } from 'react'
import type { RemoteAccount } from '@shared/types'
import { C, MONO } from '../theme'
import { PAYMENT_NOT_SEEN, PLAN_LABEL } from '@shared/billing'
import { remoteAccount, useRemoteAccount } from '../remote-account'
import { remoteBilling, useRemoteBilling } from '../remote-billing'
import { BillingButton } from './BillingButton'
import { Button } from './controls'
import { UserIcon } from './icons'
import { CHROME_ROW } from './side-panel'

/**
 * The header's account avatar. Its popover shows who this machine is signed in
 * to the remote pipeline service as, or offers Sign in with GitHub when it is not.
 */

const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

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

export default function AccountMenu({ liquid }: { liquid?: boolean }) {
  const { account, userCode, busy, error, menuOpen: open } = useRemoteAccount()

  const { billing, notSeen } = useRemoteBilling()

  useEffect(() => remoteAccount.refresh(), [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') remoteAccount.setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const signedIn = account?.state === 'signedIn' ? account : null
  const signedInLogin = signedIn?.login

  // The plan is only worth asking for while signed in.
  useEffect(() => {
    if (signedInLogin === undefined) {
      remoteBilling.reset()
      return
    }
    return remoteBilling.start()
  }, [signedInLogin])

  useEffect(() => {
    if (open && signedInLogin !== undefined) remoteBilling.refresh()
  }, [open, signedInLogin])

  const label = signedIn ? `Account: ${signedIn.login}` : 'Account: not signed in'

  return (
    <>
      <button
        type="button"
        className="bf-focus bf-icon-btn"
        onClick={() => remoteAccount.setMenuOpen(!open)}
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
          <div aria-hidden onClick={() => remoteAccount.setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
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
              background: liquid ? C.panel : C.sidebar,
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
                      {signedIn.displayName || signedIn.login}
                    </div>
                    <div style={{ color: C.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      @{signedIn.login}
                    </div>
                  </div>
                </div>
                {billing?.state === 'ok' && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 10 }}>
                    <span
                      title="Your plan"
                      style={{
                        border: `1px solid ${C.border}`,
                        borderRadius: 6,
                        padding: '1px 7px',
                        fontSize: 11,
                        fontWeight: 600,
                        color: C.textSoft
                      }}
                    >
                      {PLAN_LABEL[billing.plan]}
                    </span>
                    <BillingButton />
                  </div>
                )}
                {notSeen && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                    <span style={{ flex: 1, color: C.textSoft, lineHeight: 1.45 }}>{PAYMENT_NOT_SEEN}</span>
                    <Button variant="secondary" onClick={remoteBilling.recheck}>
                      Refresh
                    </Button>
                  </div>
                )}
                <div role="separator" style={{ height: 1, background: C.border, margin: '12px -12px 10px' }} />
                <Button variant="secondary" disabled={busy} onClick={() => void remoteAccount.signOut()} style={{ width: '100%' }}>
                  Sign out
                </Button>
              </>
            ) : account?.state === 'error' ? (
              <>
                <div style={{ color: C.textSoft, lineHeight: 1.45 }}>{account.message}</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <Button variant="primary" disabled={busy} onClick={remoteAccount.refresh} style={{ flex: 1 }}>
                    Try again
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={() => void remoteAccount.signOut()} style={{ flex: 1 }}>
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
                <Button variant="secondary" onClick={remoteAccount.cancelSignIn} style={{ width: '100%' }}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <div style={{ color: C.textSoft, lineHeight: 1.45 }}>
                  {(account?.state === 'signedOut' && account.message) || 'Sign in to run remote pipelines.'}
                </div>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void remoteAccount.signIn()}
                  style={{ width: '100%', marginTop: 10 }}
                >
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
