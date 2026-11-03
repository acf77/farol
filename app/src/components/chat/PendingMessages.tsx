import type { PendingMessage } from '../../types'
import { C } from '../../theme'

const BUTTON: React.CSSProperties = {
  flex: 'none',
  height: 22,
  padding: '0 8px',
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  background: 'transparent',
  color: C.textRow,
  fontFamily: 'inherit',
  fontSize: 11,
  cursor: 'pointer'
}

/** Messages typed while the agent works. They wait for the run to end, or "Send now" stops it. */
export function PendingMessages({
  pending,
  onSendNow,
  onRemove
}: {
  pending: PendingMessage[]
  onSendNow?: (id: string) => void
  onRemove?: (id: string) => void
}) {
  if (!pending.length) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px 0' }}>
      {pending.map((item) => (
        <div
          key={item.id}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px 5px 10px', borderRadius: 8, background: C.panel }}
        >
          <span style={{ flex: 'none', fontSize: 10, color: C.faint, textTransform: 'uppercase' }}>Pending</span>
          <span
            title={item.text}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              color: C.textSoft,
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflowWrap: 'anywhere'
            }}
          >
            {item.text}
          </span>
          <button type="button" className="bf-focus" style={BUTTON} onClick={() => onSendNow?.(item.id)}>
            Send now
          </button>
          <button
            type="button"
            className="bf-focus"
            style={{ ...BUTTON, border: 'none', padding: '0 6px', color: C.faint }}
            aria-label="Remove pending message"
            title="Remove"
            onClick={() => onRemove?.(item.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
