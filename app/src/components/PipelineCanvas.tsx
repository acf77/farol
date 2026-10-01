import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { AppSettings, PipelineNode, StepType } from '@shared/types'
import { GIT_HOOK_EVENTS, aiSelectionLabel, normalizeAi } from '@shared/types'
import { defaultGate, newPipelineNode, nodeGate, parallelAsClashIds, sanitizeAs, topoSort } from '@shared/graph'
import { C, MONO, UI, ELLIPSIS } from '../theme'
import { CliModelDropdown } from './controls'
import { Field, HAIR, Seg, SettingsGroup, SparkIcon, fieldBox } from './editor-ui'
import type { EditorState } from '../types'

interface Props {
  editor: EditorState
  settings?: AppSettings
  keyboardEnabled: boolean
  onChange: Dispatch<SetStateAction<EditorState | null>>
  onCancel: () => void
  onSave: () => void
}

const NODE_W = 380
/** Card height: header row, code preview, and an optional gate/output chip row. */
const nodeHeight = (n: PipelineNode): number =>
  60 + 42 + (nodeGate(n) || n.as ? 27 : 0)
/**
 * Ports are 10px circles, too small to be found by a tooltip alone, so they
 * grow while their node is hovered (DESIGN.md, Pipeline Editor). Transform
 * only — scaling the width would move the wire anchors.
 */
const PORT_GROW = 1.5
const PORT_MOTION = 'transform 160ms cubic-bezier(0.22,1,0.36,1)'
/** Where a pipeline's shell steps run; `local` is stored as no target. */
const RUN_TARGETS = [
  { value: 'local', label: 'This machine' },
  { value: 'remote', label: 'Remote' }
] as const

function wouldCycle(nodes: PipelineNode[], childId: string, parentId: string): boolean {
  if (childId === parentId) return true
  const next = nodes.map((n) =>
    n.id === childId ? { ...n, after: [...new Set([...n.after, parentId])] } : n
  )
  return topoSort(next) === null
}

export default function PipelineCanvas({
  editor,
  settings,
  keyboardEnabled,
  onChange,
  onCancel,
  onSave
}: Props) {
  const [sel, setSel] = useState<string | null>(editor.nodes[0]?.id ?? null)
  const [selEdge, setSelEdge] = useState<{ from: string; to: string } | null>(null)
  const [cam, setCam] = useState({ x: 48, y: 36, z: 1 })
  const [link, setLink] = useState<{ from: string; x: number; y: number } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [tab, setTab] = useState<RailTab>('step')
  const wrapRef = useRef<HTMLDivElement>(null)
  const space = useRef(false)
  const pan = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null)
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const skipClick = useRef(false)
  const pendingInsert = useRef<string | null>(null)

  const updateEditor = useCallback(
    (update: (current: EditorState) => EditorState) =>
      onChange((current) => (current ? update(current) : current)),
    [onChange]
  )

  const patch = (id: string, next: Partial<PipelineNode>): void =>
    updateEditor((current) => ({
      ...current,
      nodes: current.nodes.map((n) => {
        if (n.id !== id) return n
        const merged = { ...n, ...next }
        if (merged.type !== 'shell') return merged
        // Strip AI-only fields when switching to shell.
        const shell: PipelineNode = {
          id: merged.id,
          name: merged.name,
          type: 'shell',
          cmd: merged.cmd,
          after: merged.after,
          gate: merged.gate,
          x: merged.x,
          y: merged.y
        }
        if (merged.as) shell.as = merged.as
        return shell
      })
    }))

  const addNode = (type: StepType): void => {
    updateEditor((current) => {
      const node = newPipelineNode(current.nodes, type)
      pendingInsert.current = node.id
      return { ...current, nodes: [...current.nodes, node] }
    })
    setSelEdge(null)
  }

  const removeNode = useCallback(
    (id: string): void => {
      updateEditor((current) => {
        const nodes = current.nodes
          .filter((n) => n.id !== id)
          .map((n) => ({ ...n, after: n.after.filter((a) => a !== id) }))
        setSel(nodes[0]?.id ?? null)
        return { ...current, nodes }
      })
      setSelEdge(null)
    },
    [updateEditor]
  )

  const connect = (from: string, to: string): void => {
    const child = editor.nodes.find((n) => n.id === to)
    if (!child || wouldCycle(editor.nodes, to, from)) return
    patch(to, { after: [...new Set([...child.after, from])] })
    setSelEdge(null)
  }

  const disconnect = useCallback(
    (from: string, to: string): void => {
      updateEditor((current) => ({
        ...current,
        nodes: current.nodes.map((n) =>
          n.id === to ? { ...n, after: n.after.filter((a) => a !== from) } : n
        )
      }))
      setSelEdge(null)
    },
    [updateEditor]
  )

  useEffect(() => {
    const id = pendingInsert.current
    const node = id ? editor.nodes.find((current) => current.id === id) : undefined
    if (!node || !wrapRef.current) return
    pendingInsert.current = null
    setSel(id)
    setCam((current) => ({
      ...current,
      x: (wrapRef.current!.clientWidth - NODE_W * current.z) / 2 - node.x * current.z,
      y: (wrapRef.current!.clientHeight - nodeHeight(node) * current.z) / 2 - node.y * current.z
    }))
  }, [editor.nodes])

  const toWorld = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const box = wrapRef.current?.getBoundingClientRect()
      if (!box) return { x: 0, y: 0 }
      return { x: (clientX - box.left - cam.x) / cam.z, y: (clientY - box.top - cam.y) / cam.z }
    },
    [cam]
  )

  useEffect(() => {
    if (!keyboardEnabled) return
    const typing = (e: KeyboardEvent): boolean => {
      const t = e.target as HTMLElement
      return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
    }
    const down = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      if (e.code === 'Space' && !typing(e)) space.current = true
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (typing(e)) return
        if (selEdge) {
          e.preventDefault()
          disconnect(selEdge.from, selEdge.to)
          return
        }
        if (sel && editor.nodes.length > 1) {
          e.preventDefault()
          removeNode(sel)
        }
      }
      if (e.key === 'Escape') {
        if (typing(e)) return
        if (selEdge) {
          setSelEdge(null)
          return
        }
        onCancel()
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') space.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      space.current = false
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [keyboardEnabled, sel, selEdge, editor.nodes.length, onCancel, removeNode, disconnect])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      setCam((c) => {
        if (e.ctrlKey || e.metaKey) {
          const next = Math.min(1.8, Math.max(0.4, c.z * (e.deltaY > 0 ? 0.92 : 1.08)))
          return { ...c, z: next }
        }
        return { ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const selected = editor.nodes.find((n) => n.id === sel) ?? null
  const asClashIds = parallelAsClashIds(editor.nodes)
  const saveBlocked = !editor.name.trim() || !editor.nodes.length || asClashIds.size > 0


  const order = topoSort(editor.nodes) ?? editor.nodes
  const numOf = (id: string): number => order.findIndex((n) => n.id === id) + 1
  const selectedPos = selected ? numOf(selected.id) : 0

  return (
    <div
      role="dialog"
      aria-label="Pipeline editor"
      style={{
        flex: 1,
        minHeight: 0,
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        // Opaque full-page surface.
        background: BG,
        color: C.text,
        fontFamily: UI,
        fontSize: 13,
        overflow: 'hidden',
        userSelect: 'none'
      }}
    >
      <div
        style={{
          flex: 'none',
          height: 52,
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          padding: '0 16px 0 18px',
          borderBottom: `1px solid ${HAIR}`
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ color: C.faint }}>Pipelines</span>
          <svg width="8" height="10" viewBox="0 0 8 10" fill="none" stroke={C.fainter} strokeWidth="1.4" aria-hidden>
            <path d="M2 1.5 5.5 5 2 8.5" />
          </svg>
          <span style={{ fontWeight: 600, ...ELLIPSIS, whiteSpace: 'nowrap' }}>
            {editor.name.trim() || 'Untitled pipeline'}
          </span>
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="bf-hover-fill" onClick={onCancel} style={cancelBtn}>
            Cancel
          </button>
          <button
            type="button"
            className="bf-btn-primary"
            onClick={onSave}
            disabled={saveBlocked}
            title={asClashIds.size ? 'Resolve duplicate output names before saving' : undefined}
            style={{ ...saveBtn, opacity: saveBlocked ? 0.55 : 1 }}
          >
            Save
          </button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div
          ref={wrapRef}
          onMouseDown={(e) => {
            if (e.button === 1 || space.current) {
              pan.current = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y }
            }
          }}
          onMouseMove={(e) => {
            if (pan.current) {
              skipClick.current = true
              setCam({
                x: pan.current.cx + (e.clientX - pan.current.x),
                y: pan.current.cy + (e.clientY - pan.current.y),
                z: cam.z
              })
            }
            if (drag.current) {
              skipClick.current = true
              const w = toWorld(e.clientX, e.clientY)
              patch(drag.current.id, {
                x: w.x - drag.current.dx,
                y: w.y - drag.current.dy
              })
            }
            if (link) {
              skipClick.current = true
              const w = toWorld(e.clientX, e.clientY)
              setLink({ ...link, x: w.x, y: w.y })
            }
          }}
          onMouseUp={(e) => {
            pan.current = null
            drag.current = null
            if (link) {
              const w = toWorld(e.clientX, e.clientY)
              const hit = editor.nodes.find(
                (n) => w.x >= n.x && w.x <= n.x + NODE_W && w.y >= n.y - 14 && w.y <= n.y + 18
              )
              if (hit && hit.id !== link.from) connect(link.from, hit.id)
              setLink(null)
            }
          }}
          onMouseLeave={() => {
            pan.current = null
            drag.current = null
            setLink(null)
          }}
          onClick={() => {
            if (skipClick.current) {
              skipClick.current = false
              return
            }
            setSel(null)
            setSelEdge(null)
          }}
          style={{
            flex: 1,
            minWidth: 0,
            position: 'relative',
            overflow: 'hidden',
            cursor: space.current ? 'grab' : 'default',
            backgroundColor: C.terminal,
            backgroundImage: `radial-gradient(${DOT} 1px, transparent 1px)`,
            backgroundSize: `${22 * cam.z}px ${22 * cam.z}px`,
            backgroundPosition: `${cam.x}px ${cam.y}px`,
            // Keep the canvas opaque so the app behind cannot show through.
            isolation: 'isolate'
          }}
        >
          <svg
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              overflow: 'visible',
              pointerEvents: 'none'
            }}
          >
            {editor.nodes.flatMap((n) =>
              n.after.map((pid) => {
                const p = editor.nodes.find((x) => x.id === pid)
                if (!p) return null
                const x1 = cam.x + (p.x + NODE_W / 2) * cam.z
                const y1 = cam.y + (p.y + nodeHeight(p)) * cam.z
                const x2 = cam.x + (n.x + NODE_W / 2) * cam.z
                const y2 = cam.y + n.y * cam.z
                const mid = (y1 + y2) / 2
                const d = `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
                const on = selEdge?.from === pid && selEdge?.to === n.id
                return (
                  <g key={`${pid}->${n.id}`}>
                    <path
                      d={d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={Math.max(14, 12 * cam.z)}
                      style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSel(null)
                        setSelEdge({ from: pid, to: n.id })
                      }}
                    />
                    <path
                      d={d}
                      fill="none"
                      stroke={on ? C.accent : C.border}
                      strokeWidth={on ? 2 : 1}
                      style={{ pointerEvents: 'none' }}
                    />
                  </g>
                )
              })
            )}
            {link &&
              (() => {
                const p = editor.nodes.find((x) => x.id === link.from)
                if (!p) return null
                const x1 = cam.x + (p.x + NODE_W / 2) * cam.z
                const y1 = cam.y + (p.y + nodeHeight(p)) * cam.z
                const x2 = cam.x + link.x * cam.z
                const y2 = cam.y + link.y * cam.z
                return (
                  <path
                    d={`M ${x1} ${y1} L ${x2} ${y2}`}
                    fill="none"
                    stroke={C.accent}
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    style={{ pointerEvents: 'none' }}
                  />
                )
              })()}
          </svg>

          {selEdge &&
            (() => {
              const from = editor.nodes.find((x) => x.id === selEdge.from)
              const to = editor.nodes.find((x) => x.id === selEdge.to)
              if (!from || !to) return null
              const mx = cam.x + ((from.x + to.x) / 2 + NODE_W / 2) * cam.z
              const my = cam.y + ((from.y + nodeHeight(from) + to.y) / 2) * cam.z
              return (
                <button
                  type="button"
                  title="Remove connection"
                  onClick={(e) => {
                    e.stopPropagation()
                    disconnect(selEdge.from, selEdge.to)
                  }}
                  style={{
                    position: 'absolute',
                    left: mx - 10,
                    top: my - 10,
                    width: 20,
                    height: 20,
                    padding: 0,
                    borderRadius: '50%',
                    border: `1px solid ${C.border}`,
                    background: C.sidebar,
                    color: C.red,
                    fontSize: 13,
                    lineHeight: '18px',
                    cursor: 'pointer',
                    zIndex: 4
                  }}
                >
                  ×
                </button>
              )
            })()}

          {editor.nodes.map((n) => {
            const on = n.id === sel
            const ai = n.type === 'ai'
            const near = hover === n.id
            const clash = asClashIds.has(n.id)
            const ring = clash ? C.red : on ? C.accent : null
            const gate = nodeGate(n)
            const preview = n.cmd || (ai ? 'No prompt yet' : 'No command yet')
            return (
              <div
                key={n.id}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                onClick={(e) => {
                  e.stopPropagation()
                  setSel(n.id)
                  setSelEdge(null)
                  setTab('step')
                }}
                onMouseDown={(e) => {
                  if (e.button !== 0 || space.current) return
                  e.stopPropagation()
                  const w = toWorld(e.clientX, e.clientY)
                  drag.current = { id: n.id, dx: w.x - n.x, dy: w.y - n.y }
                  setSel(n.id)
                  setSelEdge(null)
                }}
                style={{
                  position: 'absolute',
                  left: cam.x + n.x * cam.z,
                  top: cam.y + n.y * cam.z,
                  width: NODE_W,
                  height: nodeHeight(n),
                  transform: `scale(${cam.z})`,
                  transformOrigin: '0 0',
                  boxSizing: 'border-box',
                  padding: 14,
                  borderRadius: 12,
                  border: `1px solid ${ring ?? 'oklch(1 0 0 / 0.08)'}`,
                  background: C.sidebar,
                  boxShadow: ring
                    ? `0 0 0 3px ${clash ? 'oklch(0.69 0.2 25 / 0.2)' : 'oklch(0.91 0.19 115 / 0.14)'}, 0 8px 24px rgba(0,0,0,.28)`
                    : '0 1px 2px rgba(0,0,0,.25)',
                  transition: 'border-color .12s, box-shadow .12s',
                  cursor: 'grab'
                }}
              >
                <Port edge="top" show={near || on} title="Drop a wire here" onMouseDown={(e) => e.stopPropagation()} />
                <Port
                  edge="bottom"
                  show={near || on}
                  title="Drag to connect"
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    const w = toWorld(e.clientX, e.clientY)
                    setLink({ from: n.id, x: w.x, y: w.y })
                  }}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      flex: 'none',
                      display: 'grid',
                      placeItems: 'center',
                      background: ai ? AI_TINT : C.panel
                    }}
                  >
                    {ai ? <SparkIcon /> : <ShellIcon />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, lineHeight: '16px', fontWeight: 600, whiteSpace: 'nowrap', ...ELLIPSIS }}>
                      {n.name || 'Untitled'}
                    </div>
                    <div style={{ fontSize: 11.5, lineHeight: '14px', color: C.faint, marginTop: 2, whiteSpace: 'nowrap', ...ELLIPSIS }}>
                      {ai ? `AI · ${aiSelectionLabel(normalizeAi(n.ai), n.model)}` : 'Shell'}
                    </div>
                  </div>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: C.fainter, flex: 'none' }}>
                    {String(numOf(n.id)).padStart(2, '0')}
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 12,
                    padding: '8px 10px',
                    borderRadius: 7,
                    background: C.terminal,
                    fontFamily: MONO,
                    fontSize: 11.5,
                    lineHeight: '14px',
                    color: C.textMuted,
                    whiteSpace: 'nowrap',
                    ...ELLIPSIS
                  }}
                >
                  {preview}
                </div>
                {gate || n.as ? (
                  <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                    {gate ? (
                      <div style={{ ...chip, display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                          <rect x="1.5" y="4.5" width="7" height="4.5" rx="1" />
                          <path d="M3 4.5V3a2 2 0 0 1 4 0v1.5" />
                        </svg>
                        <span>Gate</span>
                      </div>
                    ) : null}
                    {n.as ? <div style={{ ...chip, fontFamily: MONO, fontSize: 10.5 }}>{`\${${n.as}}`}</div> : null}
                  </div>
                ) : null}
              </div>
            )
          })}

          <div
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            style={{ position: 'absolute', left: 0, right: 0, bottom: 24, display: 'flex', justifyContent: 'center', gap: 8, zIndex: 5, pointerEvents: 'none' }}
          >
            <button type="button" className="bf-dashed" onClick={() => addNode('shell')} style={addBtn(C.textRow)}>
              <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
              <span>Shell step</span>
            </button>
            <button type="button" className="bf-dashed" onClick={() => addNode('ai')} style={addBtn(C.purpleSoft)}>
              <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
              <span>AI step</span>
            </button>
          </div>
        </div>

        <div
          style={{
            width: 340,
            flex: 'none',
            display: 'flex',
            flexDirection: 'column',
            background: C.sidebar,
            borderLeft: `1px solid ${HAIR}`
          }}
        >
          <div style={{ flex: 'none', padding: '14px 16px 0' }}>
            <Seg label="Editor panel" options={RAIL_TABS} value={tab} onChange={setTab} />
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 16px 24px' }}>
            {tab === 'pipeline' ? (
              <PipelineSettings editor={editor} updateEditor={updateEditor} />
            ) : selected ? (
              <Inspector
                key={selected.id}
                node={selected}
                settings={settings}
                position={`Step ${selectedPos} of ${editor.nodes.length}`}
                canDelete={editor.nodes.length > 1}
                asClash={asClashIds.has(selected.id)}
                onPatch={(p) => patch(selected.id, p)}
                onDelete={() => removeNode(selected.id)}
              />
            ) : (
              <div style={{ padding: '40px 8px', textAlign: 'center', color: C.faint, fontSize: 12.5, lineHeight: 1.5 }}>
                Select a step on the canvas to edit it.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Measurements and colours below are lifted verbatim from the Pipeline Editor design. */
const BG = 'oklch(0.17 0.006 95)'
const DOT = 'oklch(1 0 0 / 0.07)'
const AI_TINT = 'oklch(0.73 0.16 300 / 0.15)'

const RAIL_TABS = [
  { value: 'step', label: 'Step' },
  { value: 'pipeline', label: 'Pipeline' }
] as const
type RailTab = (typeof RAIL_TABS)[number]['value']

const cancelBtn: React.CSSProperties = {
  padding: '6px 14px',
  borderRadius: 7,
  background: C.panel,
  border: '1px solid oklch(1 0 0 / 0.06)',
  color: C.text,
  fontSize: 12.5,
  fontWeight: 500,
  cursor: 'pointer'
}

const saveBtn: React.CSSProperties = {
  padding: '6px 16px',
  borderRadius: 7,
  border: 'none',
  background: C.accent,
  color: C.accentInk,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer'
}

const chip: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 20,
  background: 'oklch(1 0 0 / 0.05)',
  lineHeight: '13px',
  color: C.textRow
}

const addBtn = (color: string): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '8px 14px',
  borderRadius: 9,
  border: `1px dashed ${C.border}`,
  background: 'transparent',
  color,
  fontSize: 12.5,
  cursor: 'pointer',
  pointerEvents: 'auto'
})

function Port({
  edge,
  show,
  title,
  onMouseDown
}: {
  edge: 'top' | 'bottom'
  show: boolean
  title: string
  onMouseDown: (e: React.MouseEvent) => void
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      title={title}
      style={{
        position: 'absolute',
        left: '50%',
        [edge]: -6,
        width: 10,
        height: 10,
        marginLeft: -5,
        borderRadius: '50%',
        background: C.accent,
        cursor: 'crosshair',
        zIndex: 2,
        opacity: show ? 1 : 0,
        transform: `scale(${show ? PORT_GROW : 1})`,
        transition: `${PORT_MOTION}, opacity 120ms`
      }}
    />
  )
}

function ShellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={C.textSoft} strokeWidth="1.5" aria-hidden>
      <path d="M3.5 5 6.5 8 3.5 11" />
      <path d="M8.5 11.5h4" />
    </svg>
  )
}

function Switch({ on }: { on: boolean }) {
  return (
    <div
      aria-hidden
      style={{
        width: 30,
        height: 18,
        borderRadius: 9,
        flex: 'none',
        position: 'relative',
        marginTop: 1,
        background: on ? C.accent : C.border,
        transition: 'background .15s'
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 14 : 2,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: on ? C.accentInk : C.text,
          transition: 'left .15s',
          boxShadow: '0 1px 2px rgba(0,0,0,.3)'
        }}
      />
    </div>
  )
}

function SwitchRow({
  checked,
  onChange,
  label,
  hint,
  padding,
  last
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
  padding?: string
  last?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="bf-focus"
      onClick={() => onChange(!checked)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        width: '100%',
        padding: padding ?? 0,
        border: 'none',
        borderBottom: last === false ? `1px solid oklch(1 0 0 / 0.06)` : 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer'
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        <div style={{ fontSize: 11.5, color: C.faint, marginTop: 3, lineHeight: 1.45 }}>{hint}</div>
      </div>
      <Switch on={checked} />
    </button>
  )
}

const HOOK_COPY: Record<string, { label: string; hint: string }> = {
  'pre-commit': { label: 'Before commit', hint: 'Runs as a pre-commit hook.' },
  'pre-push': { label: 'Before push', hint: 'Runs as a pre-push hook.' }
}

function PipelineSettings({
  editor,
  updateEditor
}: {
  editor: EditorState
  updateEditor: (update: (current: EditorState) => EditorState) => void
}) {
  const rowPad = '12px 13px'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Field label="Name" htmlFor="pipeline-name">
        <input
          id="pipeline-name"
          className="bf-input"
          value={editor.name}
          onChange={(e) => updateEditor((current) => ({ ...current, name: e.target.value }))}
          placeholder="My Pipeline"
          aria-label="Pipeline name"
          spellCheck={false}
          style={fieldBox}
        />
      </Field>
      <Field label="Runs on">
        <Seg
          label="Run shell steps on"
          options={RUN_TARGETS}
          value={editor.target ?? 'local'}
          onChange={(v) =>
            updateEditor((current) =>
              v === 'remote' ? { ...current, target: 'remote' } : { ...current, target: undefined, fallbackLocal: undefined }
            )
          }
        />
        {editor.target === 'remote' && (
          <SettingsGroup title="">
            <SwitchRow
              checked={editor.fallbackLocal === true}
              onChange={(v) => updateEditor((current) => ({ ...current, fallbackLocal: v }))}
              label="Fall back to this machine"
              hint="If remote fails, run locally without sandbox isolation."
              padding={rowPad}
            />
          </SettingsGroup>
        )}
      </Field>
      <SettingsGroup title="GIT HOOKS">
        {GIT_HOOK_EVENTS.map((event, i) => (
          <SwitchRow
            key={event}
            checked={editor.gitHooks?.includes(event) === true}
            onChange={(v) =>
              updateEditor((current) => {
                const rest = (current.gitHooks ?? []).filter((e) => e !== event)
                const gitHooks = v ? [...rest, event] : rest
                return gitHooks.length ? { ...current, gitHooks } : { ...current, gitHooks: undefined }
              })
            }
            label={HOOK_COPY[event]?.label ?? `Run on ${event}`}
            hint={HOOK_COPY[event]?.hint ?? `Runs as a ${event} hook.`}
            padding={rowPad}
            last={i === GIT_HOOK_EVENTS.length - 1}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup title="CHAT">
        <SwitchRow
          checked={editor.mandatory === true}
          onChange={(v) => updateEditor((current) => ({ ...current, mandatory: v }))}
          label="Mandatory in Chat"
          hint="Chat runs this after every change it makes."
          padding={rowPad}
          last={false}
        />
        <SwitchRow
          checked={editor.autoSelectable === true}
          onChange={(v) => updateEditor((current) => ({ ...current, autoSelectable: v }))}
          label="Allow Chat to auto-select"
          hint="Chat may run this when it judges it relevant."
          padding={rowPad}
        />
      </SettingsGroup>
    </div>
  )
}

const TYPE_OPTIONS: { value: StepType; label: string }[] = [
  { value: 'shell', label: 'Shell' },
  { value: 'ai', label: 'AI' }
]

function Inspector({
  node,
  settings,
  position,
  canDelete,
  asClash,
  onPatch,
  onDelete
}: {
  node: PipelineNode
  settings?: AppSettings
  position: string
  canDelete: boolean
  asClash: boolean
  onPatch: (p: Partial<PipelineNode>) => void
  onDelete: () => void
}) {
  const ai = node.type === 'ai'
  const [confirming, setConfirming] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <span style={{ fontSize: 11.5, color: C.faint }}>{position}</span>

      <Seg
        label="Step type"
        options={TYPE_OPTIONS}
        value={node.type}
        ai
        onChange={(t) =>
          onPatch(t === 'ai' ? { type: t, ai: node.ai ?? 'claude', gate: false } : { type: t, gate: true })
        }
      />

      <Field label="Name" htmlFor="step-name">
        <input
          id="step-name"
          className="bf-input"
          value={node.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="Step name"
          spellCheck={false}
          style={fieldBox}
        />
      </Field>

      {ai ? (
        <>
          <Field label="Prompt" htmlFor="step-prompt">
            <textarea
              id="step-prompt"
              className="bf-input bf-input-ai"
              value={node.cmd}
              onChange={(e) => onPatch({ cmd: e.target.value })}
              placeholder={`Prompt for ${aiSelectionLabel(normalizeAi(node.ai), node.model)}`}
              rows={5}
              style={{ ...fieldBox, padding: '9px 10px', fontSize: 12.5, lineHeight: 1.55, resize: 'vertical' }}
            />
          </Field>
          <Field label="Model">
            <CliModelDropdown
              label="Provider and model"
              provider={normalizeAi(node.ai)}
              model={node.model}
              settings={settings}
              onChange={(p, m) => onPatch({ ai: p, model: m })}
            />
          </Field>
        </>
      ) : (
        <Field label="Command" htmlFor="step-command">
          <textarea
            id="step-command"
            className="bf-input"
            value={node.cmd}
            onChange={(e) => onPatch({ cmd: e.target.value })}
            placeholder="Shell command"
            rows={4}
            spellCheck={false}
            style={{ ...fieldBox, padding: '9px 10px', fontFamily: MONO, fontSize: 12, lineHeight: 1.55, resize: 'vertical' }}
          />
        </Field>
      )}

      <Field label="Save output as" htmlFor="step-output">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '0 10px',
            borderRadius: 7,
            background: C.terminal,
            border: `1px solid ${asClash ? C.red : C.border}`,
            fontFamily: MONO,
            fontSize: 12
          }}
        >
          <span style={{ color: C.faint }}>{'${'}</span>
          <input
            id="step-output"
            value={node.as ?? ''}
            onChange={(e) => {
              const as = sanitizeAs(e.target.value)
              if (as !== undefined || !e.target.value.trim()) onPatch({ as })
            }}
            placeholder="name"
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '8px 2px',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: C.text,
              fontFamily: 'inherit',
              fontSize: 12,
              userSelect: 'text'
            }}
          />
          <span style={{ color: C.faint }}>{'}'}</span>
        </div>
        <span style={{ fontSize: 11.5, color: asClash ? C.red : C.faint, lineHeight: 1.45 }}>
          {asClash
            ? 'Parallel step already uses this name — rename or sequence them.'
            : "Later steps can read this step's output by that name."}
        </span>
      </Field>

      <div style={{ height: 1, background: HAIR }} />

      <SwitchRow
        checked={node.gate ?? defaultGate(node.type)}
        onChange={(v) => onPatch({ gate: v })}
        label="Gate"
        hint="If this step fails, the steps after it are skipped."
      />

      {canDelete && (
        <button
          type="button"
          className="bf-focus"
          onClick={() => (confirming ? onDelete() : setConfirming(true))}
          onBlur={() => setConfirming(false)}
          style={{
            alignSelf: 'flex-start',
            padding: '6px 0',
            border: 'none',
            background: 'transparent',
            fontSize: 12.5,
            color: confirming ? 'oklch(0.76 0.17 25)' : C.red,
            cursor: 'pointer'
          }}
        >
          {confirming ? 'Delete this step and its connections?' : 'Delete step'}
        </button>
      )}
    </div>
  )
}
