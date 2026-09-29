import { useRef } from 'react'
import { dragToSize, type Divider } from '../layout'

/**
 * The draggable seams between panes. `areaRef` is the box the percentages in
 * `dividers` are relative to; a drag reports the new split size for one node.
 */
export default function Dividers({
  dividers,
  areaRef,
  onResize
}: {
  dividers: Divider[]
  areaRef: React.RefObject<HTMLElement>
  onResize: (nodeId: string, size: number) => void
}) {
  const dragRef = useRef<{ d: Divider; box: DOMRect } | null>(null)

  const onDown = (d: Divider, e: React.MouseEvent): void => {
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
  }

  return (
    <>
      {dividers.map((d) => (
        <div
          key={d.id}
          onMouseDown={(e) => onDown(d, e)}
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
    </>
  )
}
