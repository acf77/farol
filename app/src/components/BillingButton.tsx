import { billingAction } from '@shared/billing'
import { C } from '../theme'
import { remoteBilling, useRemoteBilling } from '../remote-billing'
import { Button } from './controls'
import { Spinner } from './icons'

/**
 * Upgrade for a free user (or after a 402), Manage billing for trial and paid,
 * nothing for API keys or when the service sent no link. Both open the system
 * browser, never an in-app window.
 */
export function BillingButton({ style }: { style?: React.CSSProperties }) {
  const { billing, loading, paymentRequired } = useRemoteBilling()
  const action = billingAction(billing, paymentRequired)
  if (!action) return null
  const upgrade = action === 'upgrade'
  return (
    <Button
      variant={upgrade ? 'primary' : 'secondary'}
      disabled={loading}
      aria-busy={loading}
      onClick={() => void remoteBilling.open(upgrade ? 'upgrade' : 'portal')}
      style={style}
    >
      {loading && <Spinner size={11} color={upgrade ? C.accentInk : C.textSoft} />}
      {upgrade ? 'Upgrade' : 'Manage billing'}
    </Button>
  )
}
