import { C } from '../theme'

export default function ActivityDot({ active, unread = false, idle = false, title }: {
  active: boolean
  unread?: boolean
  idle?: boolean
  title?: string
}) {
  if (!active && !unread && !idle) return null
  const label = title ?? (active ? 'Activity in progress' : unread ? 'Unread updates' : undefined)
  return <span role={label ? 'status' : undefined} title={label} aria-label={label} style={{ width: 7, height: 7,
    flex: 'none', borderRadius: '50%', background: active ? C.green : unread ? C.accent : C.fainter,
    animation: active ? 'bfpulse 1.1s ease-in-out infinite' : 'none' }} />
}
