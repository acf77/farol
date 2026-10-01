import { useMemo, useRef } from 'react'
import { C } from '../theme'
import { computeLayout } from '../layout'
import { SURFACES, type Surface, type WorkspaceLayout } from '../workspace-layout'
import Dividers from './Dividers'

/**
 * Lays the chat / code / terminal surfaces out by the workspace split tree.
 * Every surface is a keyed sibling positioned absolutely, so moving a surface
 * to another branch of the tree never remounts it.
 */
export default function WorkspaceGrid({
  layout,
  keepMounted,
  surfaces,
  onFocus,
  onResize
}: {
  layout: WorkspaceLayout
  /** Surfaces that stay mounted while off screen — a terminal keeps its scrollback. */
  keepMounted: readonly Surface[]
  surfaces: Record<Surface, React.ReactNode>
  onFocus: (surface: Surface) => void
  onResize: (nodeId: string, size: number) => void
}) {
  const areaRef = useRef<HTMLDivElement>(null)
  const { panes, dividers } = useMemo(() => computeLayout(layout.root), [layout.root])
  const multi = panes.length > 1

  return (
    <div
      ref={areaRef}
      style={{ flex: 1, minWidth: 0, position: 'relative' }}
    >
      {SURFACES.map((surface) => {
        const rect = panes.find((p) => p.id === surface)
        if (!rect && !keepMounted.includes(surface)) return null
        return (
          <div
            key={surface}
            aria-hidden={!rect}
            style={
              rect
                ? {
                    position: 'absolute',
                    left: `${rect.x}%`,
                    top: `${rect.y}%`,
                    width: `${rect.w}%`,
                    height: `${rect.h}%`,
                    boxSizing: 'border-box',
                    display: 'flex',
                    // Flat panes: a hairline on every edge that touches a neighbour.
                    borderLeft: rect.x > 0 ? `1px solid ${C.hair}` : 'none',
                    borderTop: rect.y > 0 ? `1px solid ${C.hair}` : 'none'
                  }
                : { display: 'none' }
            }
          >
            <div
              onMouseDownCapture={() => onFocus(surface)}
              onFocusCapture={() => onFocus(surface)}
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                outline: multi && layout.focus === surface ? `1px solid ${C.accent}` : 'none',
                outlineOffset: -1
              }}
            >
              {surfaces[surface]}
            </div>
          </div>
        )
      })}
      <Dividers dividers={dividers} areaRef={areaRef} onResize={onResize} />
    </div>
  )
}
