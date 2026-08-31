import { useEffect, useState } from 'react'
import type { Pipeline, PipelineNode, StepState } from '@shared/types'
import { topoSort } from '@shared/graph'
import { C, MONO, UI } from '../theme'
import type { DetailLog, RunState } from '../types'
import { CaretLeft, CaretRight, CheckIcon, ChevronRight, ChevronUp, PlayIcon, Spinner, StopIcon } from './icons'

interface Props {
  pipelines: Pipeline[]
  /** Runs for the branch currently checked out, keyed by pipeline id. */
  runs: Record<string, RunState>
  logs: DetailLog[]
  selected: Pipeline | null
  onSelect: (id: string) => void
  onNew: () => void
  onRun: (id: string) => void
  onStop: (id: string) => void
  onEdit: (p: Pipeline) => void
  onDelete: (id: string) => void
  onOpenTerminal: () => void
  collapsed: boolean
  onSetCollapsed: (collapsed: boolean) => void
}

const RAIL_WIDTH = 54
const PANEL_WIDTH = 300

interface Status {
  label: string
  color: string
}

function statusOf(run: RunState | undefined): Status {
  if (!run) return { label: 'Not run', color: '#94A3B8' }
  if (run.status === 'running') return { label: 'Running', color: C.accentBright }
  if (run.status === 'pass') return { label: 'Passed', color: C.green }
  return { label: 'Failed', color: C.red }
}

function stepDot(state: StepState | undefined): string {
  return state === 'pass'
    ? '#64748B'
    : state === 'running'
      ? C.accentBright
      : state === 'fail'
        ? C.red
        : '#334155'
}

function runStatusColor(status: string | undefined, idle = '#64748B'): string {
  if (status === 'running') return C.accentBright
  if (status === 'pass') return C.green
  if (status === 'fail') return C.red
  return idle
}

function stepLabel(state: StepState | undefined): string {
  if (!state || state === 'pending') return 'Pending'
  if (state === 'skip') return 'Skipped'
  return ''
}

/** Vertical label used by the collapsed rail (the spec's `writing-mode: vertical-rl`). */
function RailLabel({
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
        letterSpacing: weight ? '0.02em' : undefined,
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

function CollapsedRail({
  shellStyle,
  pipelines,
  runs,
  selected,
  running,
  collapsed,
  onSetCollapsed,
  onSelect,
  onStop,
  setExpanded,
  setShowRail
}: {
  shellStyle: React.CSSProperties
  pipelines: Pipeline[]
  runs: Record<string, RunState>
  selected: Pipeline | null
  running: Pipeline | undefined
  collapsed: boolean
  onSetCollapsed: (collapsed: boolean) => void
  onSelect: (id: string) => void
  onStop: (id: string) => void
  setExpanded: (id: string) => void
  setShowRail: (v: boolean) => void
}) {
  const railFor = running ?? selected
  const runningRun = running ? runs[running.id] : undefined
  const done = runningRun
    ? Object.values(runningRun.stepResults).filter((s) => s === 'pass').length
    : 0
  const sel = selected ? runs[selected.id] : undefined

  return (
    <div
      className="bf-side-panel"
      style={{
        ...shellStyle,
        alignItems: 'center',
        gap: 14,
        padding: '11px 0 14px'
      }}
      onTransitionEnd={(e) => {
        if (e.propertyName !== 'width' || e.target !== e.currentTarget) return
        if (collapsed) setShowRail(true)
      }}
    >
      <button
        type="button"
        className="bf-focus bf-icon-btn"
        onClick={() => onSetCollapsed(false)}
        title="Show pipelines"
        aria-label="Show pipelines"
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          border: 0,
          background: 'transparent',
          display: 'grid',
          placeItems: 'center',
          cursor: 'pointer',
          color: '#94A3B8'
        }}
      >
        <CaretLeft />
      </button>
      <div style={{ width: 22, height: 1, background: '#273449' }} />

      {running ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <Spinner size={16} />
          <RailLabel color="#F8FAFC" weight={500}>
            {running.name}
          </RailLabel>
          <RailLabel color={C.accentBright}>
            Step {done + 1} of {running.nodes.length}
          </RailLabel>
          <div
            className="bf-icon-btn"
            onClick={() => onStop(running.id)}
            title="Stop pipeline"
            style={{
              width: 26,
              height: 26,
              borderRadius: '50%',
              background: C.accent,
              display: 'grid',
              placeItems: 'center',
              cursor: 'pointer'
            }}
          >
            <StopIcon />
          </div>
        </div>
      ) : (
        railFor && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: runStatusColor(sel?.status)
              }}
            />
            <RailLabel color="#94A3B8">{statusOf(sel).label}</RailLabel>
          </div>
        )
      )}

      <span style={{ flex: 1 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, alignItems: 'center' }}>
        {pipelines.map((p) => {
          const st = runs[p.id]
          return (
            <div
              key={p.id}
              onClick={() => {
                onSelect(p.id)
                setExpanded(p.id)
                onSetCollapsed(false)
              }}
              title={`${p.name} — ${statusOf(st).label}`}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                cursor: 'pointer',
                background: runStatusColor(st?.status, '#334155')
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

function StepRow({
  node,
  state,
  isLast
}: {
  node: PipelineNode
  state: StepState | undefined
  isLast: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '8px 9px',
        borderBottom: isLast ? 'none' : '1px solid #273449',
        color: !state || state === 'pending' ? '#94A3B8' : '#F8FAFC',
        background: state === 'running' ? 'rgba(37,99,235,.07)' : 'transparent'
      }}
    >
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          flex: 'none',
          background: stepDot(state)
        }}
      />
      <span
        title={node.cmd}
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11.8,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {node.name}
      </span>
      <span style={{ fontSize: 11.5, color: '#94A3B8', flex: 'none' }}>{stepLabel(state)}</span>
      {state === 'pass' && <CheckIcon style={{ flex: 'none' }} />}
      {state === 'running' && <Spinner style={{ flex: 'none' }} />}
      {state === 'fail' && (
        <span style={{ fontSize: 12, fontWeight: 700, color: C.red, flex: 'none' }}>✗</span>
      )}
      {(!state || state === 'pending') && (
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            border: '1.4px solid #334155',
            flex: 'none'
          }}
        />
      )}
    </div>
  )
}

function PipelineCard({
  pipeline,
  run,
  isSel,
  isExp,
  onSelect,
  onToggleExpand,
  onRun,
  onStop,
  onContextMenu
}: {
  pipeline: Pipeline
  run: RunState | undefined
  isSel: boolean
  isExp: boolean
  onSelect: () => void
  onToggleExpand: () => void
  onRun: () => void
  onStop: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const st = statusOf(run)
  const isRunning = run?.status === 'running'
  const nodes = topoSort(pipeline.nodes) ?? pipeline.nodes
  const doneCount = nodes.filter((n) => run?.stepResults[n.id] === 'pass').length

  return (
    <div
      onContextMenu={onContextMenu}
      style={{
        borderRadius: 7,
        background: isSel ? '#1F2937' : '#111827',
        border: `1px solid ${isSel ? C.accent : '#273449'}`,
        boxShadow: isSel ? '0 0 0 1px rgba(37,99,235,.25)' : 'none'
      }}
    >
      <div
        onClick={() => {
          onSelect()
          onToggleExpand()
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '10px 9px',
          cursor: 'pointer'
        }}
      >
        {isRunning ? (
          <div
            onClick={(e) => {
              e.stopPropagation()
              onStop()
            }}
            title="Stop run"
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: C.accent,
              display: 'grid',
              placeItems: 'center',
              flex: 'none',
              cursor: 'pointer'
            }}
          >
            <StopIcon />
          </div>
        ) : (
          <div
            onClick={(e) => {
              e.stopPropagation()
              onRun()
            }}
            title="Run pipeline"
            className="bf-runbtn"
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              border: `1.5px solid ${runStatusColor(run?.status)}`,
              display: 'grid',
              placeItems: 'center',
              flex: 'none',
              cursor: 'pointer'
            }}
          >
            <span className="bf-runbtn-play" style={{ display: 'none' }}>
              <PlayIcon size={8} />
            </span>
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {pipeline.name}
          </div>
          <div style={{ fontSize: 12, marginTop: 3, color: st.color }}>{st.label}</div>
        </div>
        <span style={{ fontSize: 10.5, color: '#94A3B8', flex: 'none' }}>
          {doneCount} / {nodes.length} steps
        </span>
        {isExp && <ChevronUp style={{ flex: 'none' }} />}
      </div>

      {isExp && (
        <div style={{ padding: '0 8px 8px' }}>
          <div
            style={{
              background: '#111827',
              border: '1px solid #273449',
              borderRadius: 9,
              overflow: 'hidden'
            }}
          >
            {nodes.map((n, i) => (
              <StepRow
                key={n.id}
                node={n}
                state={run?.stepResults[n.id]}
                isLast={i === nodes.length - 1}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SelectedPanel({
  selected,
  selRun,
  selStatus,
  current,
  logs,
  running,
  onStop,
  onOpenTerminal
}: {
  selected: Pipeline
  selRun: RunState | undefined
  selStatus: Status
  current: PipelineNode | undefined
  logs: DetailLog[]
  running: Pipeline | undefined
  onStop: (id: string) => void
  onOpenTerminal: () => void
}) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderTop: '1px solid #273449',
        padding: '12px 12px 10px',
        overflow: 'hidden'
      }}
    >
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 9 }}>
        <div
          style={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: runStatusColor(selRun?.status)
          }}
        />
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{selected.name}</span>
      </div>
      <div style={{ flex: 'none', fontSize: 12.5, marginTop: 4, marginLeft: 18, color: selStatus.color }}>
        {selRun ? selRun.label : 'Not run'}
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          marginTop: 13,
          display: 'flex',
          flexDirection: 'column',
          background: '#111827',
          border: '1px solid #273449',
          borderRadius: 7,
          padding: '11px 11px 5px',
          overflow: 'hidden'
        }}
      >
        <div style={{ flex: 'none', fontSize: 13, fontWeight: 600 }}>{current?.name ?? '—'}</div>
        <div
          style={{
            flex: 'none',
            maxHeight: 72,
            overflowY: 'auto',
            fontFamily: MONO,
            fontSize: 12,
            color: '#94A3B8',
            marginTop: 4,
            wordBreak: 'break-all'
          }}
        >
          {current?.cmd ?? ''}
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            marginTop: 13,
            background: '#080D17',
            borderRadius: 8,
            padding: '12px 13px',
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
            overflowY: 'auto'
          }}
        >
          {logs.slice(-4).map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 14, fontFamily: MONO, fontSize: 11.5 }}>
              <span style={{ color: '#64748B', flex: 'none' }}>{l.t}</span>
              <span style={{ color: l.color, minWidth: 0, overflowWrap: 'anywhere' }}>{l.text}</span>
            </div>
          ))}
        </div>
        <SelectedPanelFooter
          selected={selected}
          selRun={selRun}
          running={running}
          onStop={onStop}
          onOpenTerminal={onOpenTerminal}
        />
      </div>
    </div>
  )
}

function SelectedPanelFooter({
  selected,
  selRun,
  running,
  onStop,
  onOpenTerminal
}: {
  selected: Pipeline
  selRun: RunState | undefined
  running: Pipeline | undefined
  onStop: (id: string) => void
  onOpenTerminal: () => void
}) {
  if (running) {
    return (
      <button
        type="button"
        className="bf-focus bf-danger"
        onClick={() => onStop(running.id)}
        title="Stop pipeline"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          width: '100%',
          marginTop: 10,
          padding: '8px 0 7px',
          borderRadius: 7,
          border: '1px solid rgba(239, 68, 68, 0.35)',
          background: 'rgba(239, 68, 68, 0.1)',
          color: C.red,
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer'
        }}
      >
        <StopIcon size={10} />
        <span>Stop {running.name}</span>
      </button>
    )
  }
  if (selRun?.status === 'running') {
    return (
      <button
        type="button"
        className="bf-focus bf-danger"
        onClick={() => onStop(selected.id)}
        title="Stop pipeline"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          width: '100%',
          marginTop: 10,
          padding: '8px 0 7px',
          borderRadius: 7,
          border: '1px solid rgba(239, 68, 68, 0.35)',
          background: 'rgba(239, 68, 68, 0.1)',
          color: C.red,
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer'
        }}
      >
        <StopIcon size={10} />
        <span>Stop pipeline</span>
      </button>
    )
  }
  return (
    <div
      className="bf-linkish"
      onClick={onOpenTerminal}
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '10px 0 7px',
        color: '#CBD5E1',
        cursor: 'pointer'
      }}
    >
      <span style={{ fontSize: 11.5 }}>View logs</span>
      <ChevronRight />
    </div>
  )
}

function PipelineContextMenu({
  menu,
  pipelines,
  onEdit,
  onDelete,
  onClose
}: {
  menu: { id: string; x: number; y: number }
  pipelines: Pipeline[]
  onEdit: (p: Pipeline) => void
  onDelete: (id: string) => void
  onClose: () => void
}) {
  return (
    <>
      <div aria-hidden onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
      <div
        role="menu"
        style={{
          position: 'fixed',
          left: Math.min(menu.x, window.innerWidth - 170),
          top: Math.min(menu.y, window.innerHeight - 90),
          zIndex: 61,
          width: 160,
          background: '#111827',
          border: `1px solid ${C.cardBorder}`,
          borderRadius: 10,
          boxShadow: '0 14px 36px rgba(0,0,0,0.5)',
          padding: 4
        }}
      >
        <button
          type="button"
          role="menuitem"
          className="bf-focus bf-menu-item"
          onClick={() => {
            const p = pipelines.find((x) => x.id === menu.id)
            onClose()
            if (p) onEdit(p)
          }}
          style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', color: C.text }}
        >
          Edit pipeline…
        </button>
        <button
          type="button"
          role="menuitem"
          className="bf-focus bf-menu-item"
          onClick={() => {
            onClose()
            onDelete(menu.id)
          }}
          style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', color: C.red }}
        >
          Delete pipeline
        </button>
      </div>
    </>
  )
}

export default function Sidebar({
  pipelines,
  runs,
  logs,
  selected,
  onSelect,
  onNew,
  onRun,
  onStop,
  onEdit,
  onDelete,
  onOpenTerminal,
  collapsed,
  onSetCollapsed
}: Props) {
  const [expanded, setExpanded] = useState<string | null>(selected?.id ?? null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  // Keep the full panel mounted while the width shrinks, then swap to the rail.
  const [showRail, setShowRail] = useState(collapsed)
  const running = pipelines.find((p) => runs[p.id]?.status === 'running')

  useEffect(() => {
    if (!collapsed) setShowRail(false)
  }, [collapsed])

  const shellStyle: React.CSSProperties = {
    width: collapsed ? RAIL_WIDTH : PANEL_WIDTH,
    flex: 'none',
    minHeight: 0,
    alignSelf: 'stretch',
    display: 'flex',
    flexDirection: 'column',
    background: '#111827',
    border: '1px solid #273449',
    borderRadius: 8,
    overflow: 'hidden',
    fontFamily: UI,
    fontSize: 13,
    WebkitFontSmoothing: 'antialiased'
  }

  if (showRail) {
    return (
      <CollapsedRail
        shellStyle={shellStyle}
        pipelines={pipelines}
        runs={runs}
        selected={selected}
        running={running}
        collapsed={collapsed}
        onSetCollapsed={onSetCollapsed}
        onSelect={onSelect}
        onStop={onStop}
        setExpanded={setExpanded}
        setShowRail={setShowRail}
      />
    )
  }

  const selRun = selected ? runs[selected.id] : undefined
  const selStatus = statusOf(selRun)
  const selNodes = selected ? (topoSort(selected.nodes) ?? selected.nodes) : []
  const current =
    selNodes.find((n) => selRun?.stepResults[n.id] === 'running') ??
    [...selNodes].reverse().find((n) => selRun?.stepResults[n.id] === 'fail') ??
    selNodes[0]

  return (
    <div
      className="bf-side-panel"
      style={shellStyle}
      onTransitionEnd={(e) => {
        if (e.propertyName !== 'width' || e.target !== e.currentTarget) return
        if (collapsed) setShowRail(true)
      }}
    >
      <div
        style={{
          width: PANEL_WIDTH,
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column'
        }}
      >
      <div
        style={{
          height: 44,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 7px 0 12px'
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: '0.09em',
            color: '#94A3B8',
            flex: 1
          }}
        >
          PIPELINES
        </span>
        <div
          className="bf-newpipe"
          onClick={onNew}
          title="New pipeline"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '5px 10px',
            background: '#1F2937',
            border: '1px solid #273449',
            borderRadius: 7,
            fontSize: 11.5,
            fontWeight: 600,
            color: '#F8FAFC',
            cursor: 'pointer'
          }}
        >
          <span style={{ fontSize: 13, lineHeight: 1 }}>+</span>
          <span>New Pipeline</span>
        </div>
        <button
          type="button"
          className="bf-focus bf-icon-btn"
          onClick={() => onSetCollapsed(true)}
          title="Collapse panel"
          aria-label="Collapse pipelines panel"
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            border: 0,
            background: 'transparent',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            color: '#94A3B8'
          }}
        >
          <CaretRight />
        </button>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '2px 9px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10
        }}
      >
        {pipelines.map((p) => (
          <PipelineCard
            key={p.id}
            pipeline={p}
            run={runs[p.id]}
            isSel={p.id === selected?.id}
            isExp={p.id === expanded}
            onSelect={() => onSelect(p.id)}
            onToggleExpand={() => setExpanded((cur) => (cur === p.id ? null : p.id))}
            onRun={() => onRun(p.id)}
            onStop={() => onStop(p.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ id: p.id, x: e.clientX, y: e.clientY })
            }}
          />
        ))}
        {!pipelines.length && (
          <div style={{ padding: '10px 2px', fontSize: 12, color: C.faint, lineHeight: 1.5 }}>
            No pipelines yet. Use New Pipeline to create one.
          </div>
        )}
      </div>

      {selected && (
        <SelectedPanel
          selected={selected}
          selRun={selRun}
          selStatus={selStatus}
          current={current}
          logs={logs}
          running={running}
          onStop={onStop}
          onOpenTerminal={onOpenTerminal}
        />
      )}

      </div>

      {/*
        Edit and delete have no place in the spec's rail, so they live on a
        right-click menu — the panel keeps its drawn layout, and a pipeline is
        still editable without a modal.
      */}
      {menu && (
        <PipelineContextMenu
          menu={menu}
          pipelines={pipelines}
          onEdit={onEdit}
          onDelete={onDelete}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
