import { useCallback, useEffect, useRef, useState } from 'react'
import type { PipelineNode, StepType } from '@shared/types'
import { aiSelectionLabel, normalizeAi } from '@shared/types'
import { defaultGate, nextNodeId, newNodePos, nodeGate, topoSort } from '@shared/graph'
import { C, MONO, UI } from '../theme'
import { Checkbox, CliModelDropdown, ConfirmButton, SegmentedControl } from './controls'
import type { EditorState } from '../types'

interface Props {
  editor: EditorState
  onChange: (e: EditorState) => void
  onCancel: () => void
  onSave: () => void
}

const NODE_W = 188
const NODE_H = 72
/**
 * Ports are 10px circles, too small to be found by a tooltip alone, so they
 * grow while their node is hovered (DESIGN.md, Pipeline Editor). Transform
 * only — scaling the width would move the wire anchors.
 */
const PORT_GROW = 1.5
const PORT_MOTION = 'transform 160ms cubic-bezier(0.22,1,0.36,1)'
const inputStyle: React.CSSProperties = {
  height: 24,
  padding: '0 8px',
  borderRadius: 5,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(255,255,255,0.05)',
  color: C.text,
  fontSize: 12,
  outline: 'none'
}

function wouldCycle(nodes: PipelineNode[], childId: string, parentId: string): boolean {
  if (childId === parentId) return true
  const next = nodes.map((n) =>
    n.id === childId ? { ...n, after: [...new Set([...n.after, parentId])] } : n
  )
  return topoSort(next) === null
}

export default function PipelineCanvas({ editor, onChange, onCancel, onSave }: Props) {
  const [sel, setSel] = useState<string | null>(editor.nodes[0]?.id ?? null)
  const [selEdge, setSelEdge] = useState<{ from: string; to: string } | null>(null)
  const [cam, setCam] = useState({ x: 48, y: 36, z: 1 })
  const [link, setLink] = useState<{ from: string; x: number; y: number } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const space = useRef(false)
  const pan = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null)
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const skipClick = useRef(false)

  const patch = (id: string, next: Partial<PipelineNode>): void =>
    onChange({
      ...editor,
      nodes: editor.nodes.map((n) => {
        if (n.id !== id) return n
        const merged = { ...n, ...next }
        if (merged.type !== 'shell') return merged
        return {
          id: merged.id,
          name: merged.name,
          type: 'shell',
          cmd: merged.cmd,
          after: merged.after,
          gate: merged.gate,
          x: merged.x,
          y: merged.y
        }
      })
    })

  const addNode = (type: StepType): void => {
    const id = nextNodeId(editor.nodes)
    const pos = newNodePos(editor.nodes)
    const node: PipelineNode = {
      id,
      name: type === 'ai' ? 'AI step' : 'Shell step',
      type,
      cmd: '',
      ...(type === 'ai' ? { ai: 'claude' as const } : {}),
      after: [],
      gate: defaultGate(type),
      ...pos
    }
    onChange({ ...editor, nodes: [...editor.nodes, node] })
    setSel(id)
    setSelEdge(null)
  }

  const removeNode = useCallback(
    (id: string): void => {
      const nodes = editor.nodes
        .filter((n) => n.id !== id)
        .map((n) => ({ ...n, after: n.after.filter((a) => a !== id) }))
      onChange({ ...editor, nodes })
      setSel(nodes[0]?.id ?? null)
      setSelEdge(null)
    },
    [editor, onChange]
  )

  const connect = (from: string, to: string): void => {
    const child = editor.nodes.find((n) => n.id === to)
    if (!child || wouldCycle(editor.nodes, to, from)) return
    patch(to, { after: [...new Set([...child.after, from])] })
    setSelEdge(null)
  }

  const disconnect = useCallback(
    (from: string, to: string): void => {
      onChange({
        ...editor,
        nodes: editor.nodes.map((n) =>
          n.id === to ? { ...n, after: n.after.filter((a) => a !== from) } : n
        )
      })
      setSelEdge(null)
    },
    [editor, onChange]
  )

  const toWorld = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const box = wrapRef.current?.getBoundingClientRect()
      if (!box) return { x: 0, y: 0 }
      return { x: (clientX - box.left - cam.x) / cam.z, y: (clientY - box.top - cam.y) / cam.z }
    },
    [cam]
  )

  useEffect(() => {
    const typing = (e: KeyboardEvent): boolean => {
      const t = e.target as HTMLElement
      return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
    }
    const down = (e: KeyboardEvent): void => {
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
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [sel, selEdge, editor.nodes.length, onCancel, removeNode, disconnect])

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
        // Opaque full-page surface — never inherit Liquid Glass / chrome transparency.
        background: '#080D17',
        fontFamily: UI,
        userSelect: 'none'
      }}
    >
      <div
        style={{
          flex: 'none',
          height: 48,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 14px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          background: '#111827'
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: C.dim }}>Pipeline</span>
        <input
          className="bf-input"
          value={editor.name}
          onChange={(e) => onChange({ ...editor, name: e.target.value })}
          placeholder="My Pipeline"
          spellCheck={false}
          style={{ ...inputStyle, width: 220, height: 26 }}
        />
        <Checkbox
          checked={editor.mandatory === true}
          onChange={(v) => onChange({ ...editor, mandatory: v })}
        >
          Mandatory in Chat
        </Checkbox>
        <button className="bf-hover-fill" onClick={() => addNode('shell')} style={toolBtn}>
          + Shell
        </button>
        <button className="bf-hover-fill" onClick={() => addNode('ai')} style={toolBtn}>
          + AI
        </button>
        <div style={{ flex: 1 }} />
        <button className="bf-hover-fill" onClick={onCancel} style={toolBtn}>
          Cancel
        </button>
        <button
          className="bf-btn-primary"
          onClick={onSave}
          disabled={!editor.name.trim() || !editor.nodes.length}
          style={{
            ...toolBtn,
            border: 'none',
            background: editor.name.trim() ? C.accent : 'rgba(37,99,235,0.35)',
            color: '#fff',
            fontWeight: 600
          }}
        >
          Save
        </button>
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
                (n) =>
                  w.x >= n.x && w.x <= n.x + NODE_W && w.y >= n.y - 14 && w.y <= n.y + 18
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
            backgroundColor: '#111827',
            backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)',
            backgroundSize: `${22 * cam.z}px ${22 * cam.z}px`,
            backgroundPosition: `${cam.x}px ${cam.y}px`,
            // Keep the canvas opaque under Liquid Glass so the app behind cannot show through.
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
                const y1 = cam.y + (p.y + NODE_H) * cam.z
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
                      stroke={on ? C.accent : 'rgba(37,99,235,0.55)'}
                      strokeWidth={(on ? 2.5 : 1.5) * cam.z}
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
                const y1 = cam.y + (p.y + NODE_H) * cam.z
                const x2 = cam.x + link.x * cam.z
                const y2 = cam.y + link.y * cam.z
                return (
                  <path
                    d={`M ${x1} ${y1} L ${x2} ${y2}`}
                    fill="none"
                    stroke={C.accent}
                    strokeWidth={1.5 * cam.z}
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
              const my = cam.y + ((from.y + NODE_H + to.y) / 2) * cam.z
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
                    left: mx - 9,
                    top: my - 9,
                    width: 18,
                    height: 18,
                    padding: 0,
                    borderRadius: '50%',
                    border: '1px solid rgba(255,255,255,0.18)',
                    background: '#111827',
                    color: C.red,
                    fontSize: 13,
                    lineHeight: '16px',
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
            return (
              <div
                key={n.id}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                onClick={(e) => {
                  e.stopPropagation()
                  setSel(n.id)
                  setSelEdge(null)
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
                  width: NODE_W * cam.z,
                  minHeight: NODE_H * cam.z,
                  boxSizing: 'border-box',
                  padding: `${8 * cam.z}px ${10 * cam.z}px`,
                  borderRadius: 8,
                  border: on ? `1px solid ${C.accent}` : '1px solid #273449',
                  background: ai ? 'rgba(191,90,242,0.15)' : '#111827',
                  boxShadow: on ? '0 0 0 3px rgba(37,99,235,0.18)' : '0 8px 24px rgba(0,0,0,0.35)',
                  cursor: 'grab'
                }}
              >
                <div
                  onMouseDown={(e) => e.stopPropagation()}
                  title="Drop a wire here"
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: -6 * cam.z,
                    width: 10 * cam.z,
                    height: 10 * cam.z,
                    marginLeft: -5 * cam.z,
                    borderRadius: '50%',
                    background: 'rgba(37,99,235,0.85)',
                    cursor: 'crosshair',
                    zIndex: 2,
                    transform: `scale(${near ? PORT_GROW : 1})`,
                    transition: PORT_MOTION
                  }}
                />
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    const w = toWorld(e.clientX, e.clientY)
                    setLink({ from: n.id, x: w.x, y: w.y })
                  }}
                  title="Drag to connect"
                  style={{
                    position: 'absolute',
                    left: '50%',
                    bottom: -6 * cam.z,
                    width: 10 * cam.z,
                    height: 10 * cam.z,
                    marginLeft: -5 * cam.z,
                    borderRadius: '50%',
                    background: C.accent,
                    cursor: 'crosshair',
                    zIndex: 2,
                    transform: `scale(${near ? PORT_GROW : 1})`,
                    transition: PORT_MOTION
                  }}
                />
                <div
                  style={{
                    fontSize: 9 * cam.z,
                    fontWeight: 700,
                    letterSpacing: '0.4px',
                    color: ai ? C.purpleSoft : C.dim,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {ai ? `AI · ${aiSelectionLabel(normalizeAi(n.ai), n.model)}` : 'SHELL'}
                  {nodeGate(n) ? ' · GATE' : ''}
                </div>
                <div
                  style={{
                    marginTop: 4 * cam.z,
                    fontSize: 12 * cam.z,
                    fontWeight: 600,
                    color: '#fff',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                >
                  {n.name || (ai ? 'AI step' : 'Shell step')}
                </div>
              </div>
            )
          })}
        </div>

        {selected && (
          <Inspector
            node={selected}
            canDelete={editor.nodes.length > 1}
            onPatch={(p) => patch(selected.id, p)}
            onDelete={() => removeNode(selected.id)}
          />
        )}
      </div>
    </div>
  )
}

const toolBtn: React.CSSProperties = {
  height: 26,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid #273449',
  background: 'rgba(255,255,255,0.05)',
  color: C.textSoft,
  fontSize: 12,
  cursor: 'pointer'
}

const TYPE_OPTIONS: { value: StepType; label: string }[] = [
  { value: 'shell', label: 'SHELL' },
  { value: 'ai', label: 'AI' }
]

function Inspector({
  node,
  canDelete,
  onPatch,
  onDelete
}: {
  node: PipelineNode
  canDelete: boolean
  onPatch: (p: Partial<PipelineNode>) => void
  onDelete: () => void
}) {
  const ai = node.type === 'ai'
  return (
    <div
      style={{
        flex: 'none',
        width: 280,
        borderLeft: '1px solid rgba(255,255,255,0.08)',
        background: '#111827',
        padding: 14,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 10
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600 }}>Step</div>
      <SegmentedControl
        label="Step type"
        options={TYPE_OPTIONS}
        value={node.type}
        tone={ai ? 'ai' : 'neutral'}
        onChange={(t) =>
          onPatch(t === 'ai' ? { type: t, ai: node.ai ?? 'claude', gate: false } : { type: t, gate: true })
        }
      />
      <input
        className="bf-input"
        value={node.name}
        onChange={(e) => onPatch({ name: e.target.value })}
        placeholder="Step name"
        spellCheck={false}
        style={inputStyle}
      />
      {ai && (
        <CliModelDropdown
          label="CLI and model"
          provider={normalizeAi(node.ai)}
          model={node.model}
          onChange={(p, m) => onPatch({ ai: p, model: m })}
        />
      )}
      {ai ? (
        <textarea
          className="bf-input"
          value={node.cmd}
          onChange={(e) => onPatch({ cmd: e.target.value })}
          placeholder={`Prompt for ${aiSelectionLabel(normalizeAi(node.ai), node.model)}`}
          rows={8}
          spellCheck={false}
          style={{
            ...inputStyle,
            height: 'auto',
            minHeight: 120,
            resize: 'vertical',
            padding: '6px 8px',
            fontFamily: MONO,
            fontSize: 11,
            lineHeight: 1.45
          }}
        />
      ) : (
        <input
          className="bf-input"
          value={node.cmd}
          onChange={(e) => onPatch({ cmd: e.target.value })}
          placeholder="Shell command"
          spellCheck={false}
          style={{ ...inputStyle, fontFamily: MONO, fontSize: 11 }}
        />
      )}
      <Checkbox
        checked={node.gate ?? defaultGate(node.type)}
        onChange={(v) => onPatch({ gate: v })}
      >
        Gate: skip descendants if this fails
      </Checkbox>
      {canDelete && (
        <ConfirmButton
          label="Delete step"
          confirmLabel="Delete this step and its connections?"
          onConfirm={onDelete}
          style={{ marginTop: 8, alignSelf: 'flex-start', flexWrap: 'wrap' }}
        />
      )}
    </div>
  )
}
