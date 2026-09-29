import { useEffect, useState, type CSSProperties, type TransitionEvent } from 'react'
import { C, UI } from '../theme'

export const SIDE_RAIL_WIDTH = 54
export const SIDE_PANEL_WIDTH = 280
/** Toolbar row. Sidebars start below this, never inside it. */
export const CHROME_ROW = 52
/** Gap between chrome and both side panels, and from the window edges. */
export const PANEL_INSET = 10
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

export function sidePanelShellStyle(
  collapsed: boolean,
  opts?: { animate?: boolean; panelWidth?: number; railWidth?: number }
): CSSProperties {
  const panelWidth = opts?.panelWidth ?? SIDE_PANEL_WIDTH
  const railWidth = opts?.railWidth ?? SIDE_RAIL_WIDTH
  return {
    width: collapsed ? railWidth : panelWidth,
    flex: 'none',
    minHeight: 0,
    alignSelf: 'stretch',
    display: 'flex',
    flexDirection: 'column',
    background: C.sidebar,
    border: '1px solid #3E3E3A',
    borderRadius: 12,
    overflow: 'hidden',
    fontFamily: UI,
    fontSize: 13,
    WebkitFontSmoothing: 'antialiased',
    ...(opts?.animate ? { transition: 'width 180ms ease' } : {})
  }
}
