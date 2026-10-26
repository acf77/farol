import { useEffect, useState, type CSSProperties, type TransitionEvent } from 'react'
import { C, UI } from '../theme'
import { ChevronUp } from './icons'

export const SIDE_RAIL_WIDTH = 44
export const SIDE_PANEL_WIDTH = 280
/** Toolbar row. Sidebars start below this, never inside it. */
export const CHROME_ROW = 48
/** One floating square in the right column: as tall as its content up to `max`, then it scrolls. */
export const sideCardStyle: CSSProperties = {
  background: C.sidebar,
  border: `1px solid ${C.hair}`,
  borderRadius: 12,
  boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
  overflow: 'hidden'
}

/** Small uppercase heading with a count pill, shared by the stacked cards. */
export function CardTitle({ title, count }: { title: string; count: number }) {
  return (
    <>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', color: C.faint }}>{title}</span>
      <span style={{ padding: '1px 7px', borderRadius: 20, background: 'oklch(1 0 0 / 0.08)', fontSize: 11, fontWeight: 500, color: C.textSoft }}>{count}</span>
    </>
  )
}

/**
 * With `title`, the card is a closed one-line header that opens on click; `aside` stays visible
 * when closed. Without it, the card is a plain scrolling box.
 */
export function SideCard({ label, max = 360, title, count = 0, aside, children }: {
  label: string
  max?: number
  title?: string
  count?: number
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <section
      aria-label={label}
      style={{ ...sideCardStyle, flex: 'none', minWidth: 0, maxHeight: max, display: 'flex', flexDirection: 'column' }}
    >
      {title && (
        <button
          type="button"
          className="bf-focus"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          style={{ flex: 'none', height: 36, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px 0 16px', border: 0, background: 'transparent', fontFamily: 'inherit', cursor: 'pointer' }}
        >
          <CardTitle title={title} count={count} />
          <span style={{ flex: 1 }} />
          {aside}
          <ChevronUp size={10} color={C.faint} style={{ flex: 'none', transform: open ? 'rotate(180deg)' : 'none' }} />
        </button>
      )}
      {(!title || open) && <div style={{ minHeight: 0, overflow: 'auto' }}>{children}</div>}
    </section>
  )
}

export function RailLabel({
  children,
  color,
  weight
}: {
  children: React.ReactNode
  color: string
  weight?: number
}) {
  return (
    <div
      style={{
        writingMode: 'vertical-rl',
        transform: 'rotate(180deg)',
        fontSize: weight ? 11.5 : 11,
        fontWeight: weight,
        letterSpacing: weight ? '0.02em' : '0.08em',
        color,
        maxHeight: 220,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis'
      }}
    >
      {children}
    </div>
  )
}

export function useCollapseRail(collapsed: boolean) {
  const [showRail, setShowRail] = useState(collapsed)

  useEffect(() => {
    if (!collapsed) setShowRail(false)
  }, [collapsed])

  const onWidthTransitionEnd = (e: TransitionEvent<HTMLElement>) => {
    if (e.propertyName !== 'width' || e.target !== e.currentTarget) return
    if (collapsed) setShowRail(true)
  }

  return { showRail, setShowRail, onWidthTransitionEnd }
}

/** `edge` is the side that touches the workspace — it carries the hairline. */
export function sidePanelShellStyle(
  collapsed: boolean,
  opts?: { animate?: boolean; panelWidth?: number; railWidth?: number; edge?: 'left' | 'right' }
): CSSProperties {
  const panelWidth = opts?.panelWidth ?? SIDE_PANEL_WIDTH
  const railWidth = opts?.railWidth ?? SIDE_RAIL_WIDTH
  return {
    boxSizing: 'border-box',
    width: collapsed ? railWidth : panelWidth,
    flex: 'none',
    minHeight: 0,
    alignSelf: 'stretch',
    display: 'flex',
    flexDirection: 'column',
    background: C.sidebar,
    color: C.text,
    overflow: 'hidden',
    ...(opts?.edge === 'left' ? { borderLeft: `1px solid ${C.hair}` } : { borderRight: `1px solid ${C.hair}` }),
    fontFamily: UI,
    fontSize: 13,
    WebkitFontSmoothing: 'antialiased',
    ...(opts?.animate ? { transition: 'width 180ms ease' } : {})
  }
}
