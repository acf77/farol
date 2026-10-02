import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { AppSettings, PipelineNode, StepType } from '@shared/types'
import { GIT_HOOK_EVENTS, aiSelectionLabel, normalizeAi } from '@shared/types'
import { defaultGate, newPipelineNode, nodeGate, parallelAsClashIds, sanitizeAs, topoSort } from '@shared/graph'
import { C, MONO, UI, ELLIPSIS } from '../theme'
import { SIGN_IN_REQUIRED } from '@shared/remote'
import { remoteAccount, useRemoteAccount } from '../remote-account'
import { Button, Checkbox, CliModelDropdown, ConfirmButton, SegmentedControl } from './controls'
import type { EditorState } from '../types'

interface Props {
  editor: EditorState
  settings?: AppSettings
  keyboardEnabled: boolean
  onChange: Dispatch<SetStateAction<EditorState | null>>
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
/** Where a pipeline's shell steps run; `local` is stored as no target. */
const RUN_TARGETS = [
  { value: 'local', label: 'This machine' },
  { value: 'remote', label: 'Remote' }
] as const

const inputStyle: React.CSSProperties = {
  height: 24,
  padding: '0 8px',
  borderRadius: 4,
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
      y: (wrapRef.current!.clientHeight - NODE_H * current.z) / 2 - node.y * current.z
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
        background: C.terminal,
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
          background: C.sidebar
        }}
      >
        <span style={{ fontSize: 12, color: C.textMuted }}>Pipelines</span>
        <span style={{ fontSize: 12, color: C.textMuted }}>›</span>
        <span style={{ fontSize: 12, fontWeight: 600, minWidth: 0, maxWidth: 260, ...ELLIPSIS }}>
          {editor.name.trim() || 'Untitled pipeline'}
        </span>
        <span style={{ width: 8 }} />
        <button type="button" className="bf-hover-fill" onClick={() => addNode('shell')} style={toolBtn}>
          + Shell
        </button>
        <button type="button" className="bf-hover-fill" onClick={() => addNode('ai')} style={toolBtn}>
          + AI
        </button>
        <div style={{ flex: 1 }} />
        <button className="bf-hover-fill" onClick={onCancel} style={toolBtn}>
          Cancel
        </button>
        <button
          className="bf-btn-primary"
          onClick={onSave}
          disabled={saveBlocked}
          title={asClashIds.size ? 'Resolve duplicate output names before saving' : undefined}
          style={{
            ...toolBtn,
            border: 'none',
            background: !saveBlocked ? C.accent : 'rgba(214, 242, 58, 0.28)',
            color: C.accentInk,
            fontWeight: 600,
            opacity: saveBlocked ? 0.55 : 1
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
            backgroundColor: C.sidebar,
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
                      stroke={on ? C.accent : 'rgba(214, 242, 58,0.55)'}
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
                    background: C.sidebar,
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
            const clash = asClashIds.has(n.id)
            const ring = clash ? C.red : on ? C.accent : null
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
                  width: NODE_W * cam.z,
                  minHeight: NODE_H * cam.z,
                  boxSizing: 'border-box',
                  padding: `${8 * cam.z}px ${10 * cam.z}px`,
                  borderRadius: 8,
                  border: `1px solid ${ring ?? C.border}`,
                  background: ai ? 'rgba(184, 148, 255,0.15)' : C.sidebar,
                  boxShadow: ring
                    ? `0 0 0 3px ${clash ? 'rgba(255, 107, 107, 0.22)' : 'rgba(214, 242, 58,0.18)'}`
                    : '0 8px 24px rgba(0,0,0,0.35)',
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
                    background: 'rgba(214, 242, 58,0.85)',
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
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6 * cam.z,
                    minWidth: 0,
                    fontSize: 10 * cam.z,
                    fontWeight: 700,
                    letterSpacing: '0.4px',
                    color: ai ? C.purpleSoft : C.textMuted
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      ...ELLIPSIS
                    }}
                  >
                    {ai ? `AI · ${aiSelectionLabel(normalizeAi(n.ai), n.model)}` : 'SHELL'}
                    {nodeGate(n) ? ' · GATE' : ''}
                  </span>
                  {n.as ? (
                    <span
                      style={{
                        flex: 'none',
                        padding: `${1 * cam.z}px ${5 * cam.z}px`,
                        borderRadius: 4 * cam.z,
                        background: 'rgba(214, 242, 58, 0.14)',
                        color: C.accent,
                        fontFamily: MONO,
                        fontSize: 10 * cam.z
                      }}
                    >
                      {`\${${n.as}}`}
                    </span>
                  ) : null}
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

        <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', width: 280, background: C.sidebar, borderLeft: '1px solid rgba(255,255,255,0.08)' }}>
          <SegmentedControl
            label="Editor panel"
            options={RAIL_TABS}
            value={tab}
            onChange={setTab}
            style={{ margin: '14px 14px 0' }}
          />
          {tab === 'pipeline' ? (
            <PipelineSettings editor={editor} updateEditor={updateEditor} />
          ) : selected ? (
            <Inspector
              node={selected}
              settings={settings}
              canDelete={editor.nodes.length > 1}
              asClash={asClashIds.has(selected.id)}
              onPatch={(p) => patch(selected.id, p)}
              onDelete={() => removeNode(selected.id)}
            />
          ) : (
            <div style={{ padding: '40px 22px', textAlign: 'center', fontSize: 12, color: C.textMuted, lineHeight: 1.5 }}>
              Select a step on the canvas to edit it.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const toolBtn: React.CSSProperties = {
  height: 26,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid #3E3E3A',
  background: 'rgba(255,255,255,0.05)',
  color: C.textSoft,
  fontSize: 12,
  cursor: 'pointer'
}

const RAIL_TABS = [
  { value: 'step', label: 'STEP' },
  { value: 'pipeline', label: 'PIPELINE' }
] as const
type RailTab = (typeof RAIL_TABS)[number]['value']

const railStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  padding: 14,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 10
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  title
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
  title?: string
}) {
  return (
    <Checkbox checked={checked} onChange={onChange} title={title} style={{ alignItems: 'flex-start', padding: '4px 0' }}>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ color: C.text, fontSize: 12 }}>{label}</span>
        <span style={{ color: C.textMuted, lineHeight: 1.4 }}>{hint}</span>
      </span>
    </Checkbox>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 8, fontSize: 10, fontWeight: 700, letterSpacing: '0.6px', color: C.textMuted }}>
      {children}
    </div>
  )
}

function PipelineSettings({
  editor,
  updateEditor
}: {
  editor: EditorState
  updateEditor: (update: (current: EditorState) => EditorState) => void
}) {
  const { account } = useRemoteAccount()
  return (
    <div style={railStyle}>
      <input
        className="bf-input"
        value={editor.name}
        onChange={(e) => updateEditor((current) => ({ ...current, name: e.target.value }))}
        placeholder="My Pipeline"
        aria-label="Pipeline name"
        spellCheck={false}
        style={inputStyle}
      />
      <GroupLabel>RUNS ON</GroupLabel>
      <SegmentedControl
        label="Run shell steps on"
        options={RUN_TARGETS}
        value={editor.target ?? 'local'}
        onChange={(v) =>
          updateEditor((current) =>
            v === 'remote' ? { ...current, target: 'remote' } : { ...current, target: undefined, fallbackLocal: undefined }
          )
        }
      />
      {editor.target === 'remote' && account?.state === 'signedOut' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.textSoft }}>
          <span style={{ flex: 1 }}>{SIGN_IN_REQUIRED}</span>
          <Button variant="primary" onClick={() => void remoteAccount.signIn()}>
            Sign in
          </Button>
        </div>
      )}
      {editor.target === 'remote' && (
        <Toggle
          checked={editor.fallbackLocal === true}
          onChange={(v) => updateEditor((current) => ({ ...current, fallbackLocal: v }))}
          label="Fall back to this machine"
          hint="If remote fails, run locally without sandbox isolation."
        />
      )}
      <GroupLabel>GIT HOOKS</GroupLabel>
      {GIT_HOOK_EVENTS.map((event) => (
        <Toggle
          key={event}
          checked={editor.gitHooks?.includes(event) === true}
          onChange={(v) =>
            updateEditor((current) => {
              const rest = (current.gitHooks ?? []).filter((e) => e !== event)
              const gitHooks = v ? [...rest, event] : rest
              return gitHooks.length ? { ...current, gitHooks } : { ...current, gitHooks: undefined }
            })
          }
          label={`Run on ${event}`}
          hint="Runs when Farol is open; skipped otherwise, so the repo stays usable without it."
        />
      ))}
      <GroupLabel>CHAT</GroupLabel>
      <Toggle
        checked={editor.mandatory === true}
        onChange={(v) => updateEditor((current) => ({ ...current, mandatory: v }))}
        label="Mandatory in Chat"
        hint="Chat runs this after every change it makes."
      />
      <Toggle
        checked={editor.autoSelectable === true}
        onChange={(v) => updateEditor((current) => ({ ...current, autoSelectable: v }))}
        label="Allow Chat to auto-select"
        hint="Chat may run this when it judges it relevant."
      />
    </div>
  )
}
const TYPE_OPTIONS: { value: StepType; label: string }[] = [
  { value: 'shell', label: 'SHELL' },
  { value: 'ai', label: 'AI' }
]

function Inspector({
  node,
  settings,
  canDelete,
  asClash,
  onPatch,
  onDelete
}: {
  node: PipelineNode
  settings?: AppSettings
  canDelete: boolean
  asClash: boolean
  onPatch: (p: Partial<PipelineNode>) => void
  onDelete: () => void
}) {
  const ai = node.type === 'ai'
  return (
    <div style={railStyle}>
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
      <input
        className="bf-input"
        value={node.as ?? ''}
        onChange={(e) => {
          const as = sanitizeAs(e.target.value)
          if (as !== undefined || !e.target.value.trim()) onPatch({ as })
        }}
        placeholder="as (output name for ${…})"
        spellCheck={false}
        style={{
          ...inputStyle,
          fontFamily: MONO,
          fontSize: 11,
          borderColor: asClash ? C.red : undefined
        }}
      />
      {asClash ? (
        <div style={{ fontSize: 11, color: C.red, lineHeight: 1.35, marginTop: -4 }}>
          Parallel step already uses this name — rename or sequence them.
        </div>
      ) : null}
      {ai && (
        <CliModelDropdown
          label="Provider and model"
          provider={normalizeAi(node.ai)}
          model={node.model}
          settings={settings}
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
