import { useCallback, useMemo, useRef } from 'react'
import { C } from '../theme'
import type { Tab } from '../types'
import { computeLayout, dragToSize, leaves, type Divider } from '../layout'
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
  const dragRef = useRef<{ d: Divider; box: DOMRect } | null>(null)
  const layout = useMemo(() => computeLayout(tab.root), [tab.root])
  const multi = leaves(tab.root).length > 1

  const onDividerDown = useCallback(
    (d: Divider, e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const box = areaRef.current?.getBoundingClientRect()
      if (!box) return
      dragRef.current = { d, box }

      const onMove = (ev: PointerEvent): void => {
        const cur = dragRef.current
        if (!cur) return
        const frac =
          cur.d.dir === 'row'
            ? (ev.clientX - cur.box.left) / cur.box.width
            : (ev.clientY - cur.box.top) / cur.box.height
        onResize(cur.d.id, dragToSize(cur.d, frac))
      }
      const onUp = (): void => {
        dragRef.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [onResize]
  )

  return (
    <div
      ref={areaRef}
      onContextMenu={onContextMenu}
      style={{ flex: 1, minHeight: 0, height: '100%', position: 'relative', background: '#181817' }}
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
                  background: '#232322',
                  borderBottom: '1px solid #3E3E3A',
                  color: focused ? '#F0F0EC' : '#A1A19A',
                  fontSize: 11
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {pane.title}
                </span>
                <span
                  className="bf-tab-close"
                  title="Close pane"
                  onClick={(e) => {
                    e.stopPropagation()
                    onClosePane(pane.id)
                  }}
                  style={{
                    width: 14,
                    height: 14,
                    display: 'grid',
                    placeItems: 'center',
                    cursor: 'pointer',
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.35)'
                  }}
                >
                  ×
                </span>
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

      {layout.dividers.map((d) => (
        <div
          key={d.id}
          onMouseDown={(e) => onDividerDown(d, e)}
          style={{
            position: 'absolute',
            left: d.dir === 'row' ? `calc(${d.x}% - 2px)` : `${d.x}%`,
            top: d.dir === 'col' ? `calc(${d.y}% - 2px)` : `${d.y}%`,
            width: d.dir === 'row' ? 4 : `${d.w}%`,
            height: d.dir === 'col' ? 4 : `${d.h}%`,
            cursor: d.dir === 'row' ? 'col-resize' : 'row-resize',
            zIndex: 5,
            background: 'transparent'
          }}
        />
      ))}
    </div>
  )
}
