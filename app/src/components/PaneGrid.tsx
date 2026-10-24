import { useMemo, useRef } from 'react'
import { C, ELLIPSIS } from '../theme'
import type { Tab } from '../types'
import { computeLayout, leaves } from '../layout'
import Dividers from './Dividers'
import XtermPane from './XtermPane'
import LogPane from './LogPane'

interface Props {
  tab: Tab
  visible: boolean
  onFocusPane: (paneId: string) => void
  onClosePane: (paneId: string) => void
  onResize: (nodeId: string, size: number) => void
  onContextMenu?: (e: React.MouseEvent) => void
}

/**
 * Renders a tab's pane tree: leaves are terminals/logs, splits are draggable
 * dividers. Multi-pane tabs get a thin title bar and a focus ring.
 */
export default function PaneGrid({
  tab,
  visible,
  onFocusPane,
  onClosePane,
  onResize,
  onContextMenu
}: Props) {
  const areaRef = useRef<HTMLDivElement>(null)
  const layout = useMemo(() => computeLayout(tab.root), [tab.root])
  const multi = leaves(tab.root).length > 1

  return (
    <div
      ref={areaRef}
      onContextMenu={onContextMenu}
      style={{ flex: 1, minHeight: 0, height: '100%', position: 'relative', background: C.app }}
    >
      {layout.panes.map((rect) => {
        const pane = tab.panes[rect.id]
        if (!pane) return null
        const focused = tab.focus === pane.id
        return (
          <div
            key={pane.id}
            onMouseDown={() => onFocusPane(pane.id)}
            style={{
              position: 'absolute',
              left: `${rect.x}%`,
              top: `${rect.y}%`,
              width: `${rect.w}%`,
              height: `${rect.h}%`,
              display: 'flex',
              flexDirection: 'column',
              boxSizing: 'border-box',
              padding: multi ? 2 : 0,
              outline: multi && focused ? `1px solid ${C.accent}` : 'none',
              outlineOffset: -1
            }}
          >
            {multi && (
              <div
                style={{
                  flex: 'none',
                  height: 22,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '0 8px',
                  background: C.sidebar,
                  borderBottom: '1px solid #3E3E3A',
                  color: focused ? C.text : C.textMuted,
                  fontSize: 11
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    ...ELLIPSIS
                  }}
                >
                  {pane.title}
                </span>
                <button
                  type="button"
                  className="bf-tab-close bf-focus"
                  title="Close pane"
                  aria-label={`Close ${pane.title} pane`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onClosePane(pane.id)
                  }}
                  style={{
                    width: 14,
                    height: 14,
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    display: 'grid',
                    placeItems: 'center',
                    cursor: 'pointer',
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.35)'
                  }}
                >
                  ×
                </button>
              </div>
            )}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                position: 'relative',
                display: 'flex',
                flexDirection: 'column'
              }}
            >
              {pane.kind === 'shell' ? (
                <XtermPane
                  paneId={pane.id}
                  cwd={pane.cwd}
                  agent={pane.agent}
                  visible={visible}
                  focused={visible && focused}
                  onFocus={() => onFocusPane(pane.id)}
                />
              ) : pane.kind === 'run' ? (
                <LogPane term={pane.term} />
              ) : null}
            </div>
          </div>
        )
      })}

      <Dividers dividers={layout.dividers} areaRef={areaRef} onResize={onResize} />
    </div>
  )
}
