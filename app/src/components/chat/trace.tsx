import { useState } from 'react'
import { C, MONO, ELLIPSIS } from '../../theme'
import { ChevronRight } from '../icons'

/**
 * Trace, ported from shadcn/ui to inline styles: one step of agent work as a
 * quiet line, optionally expandable to show what the step touched.
 */
export function TraceLine({
  icon,
  title,
  description,
  status
}: {
  icon: React.ReactNode
  title: string
  description?: string
  status?: 'running' | 'error' | 'pending'
}) {
  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        minWidth: 0,
        color: status === 'error' ? C.red : undefined,
        opacity: status === 'pending' ? 0.6 : undefined
      }}
    >
      <span aria-hidden style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 10, flex: 'none' }}>
        {icon}
      </span>
      <span className={status === 'running' ? 'bf-shimmer' : undefined} style={{ flex: 'none', fontFamily: MONO, fontSize: 11.5 }}>
        {title}
      </span>
      {description && (
        <span style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11, color: C.faint, ...ELLIPSIS }}>{description}</span>
      )}
    </span>
  )
}

export function TraceCollapsible({ line, children }: { line: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="bf-focus bf-trace-trigger"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          width: '100%',
          minWidth: 0,
          padding: 0,
          border: 'none',
          borderRadius: 6,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer'
        }}
      >
        {line}
        <ChevronRight
          aria-hidden
          size={13}
          style={{ flex: 'none', transition: 'transform 150ms', transform: open ? 'rotate(90deg)' : undefined }}
        />
      </button>
      {open && (
        <div style={{ margin: '8px 0 4px 4px', paddingLeft: 14, borderLeft: `1px solid ${C.hair}`, minWidth: 0 }}>{children}</div>
      )}
    </>
  )
}
