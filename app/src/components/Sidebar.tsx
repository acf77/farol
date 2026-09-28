import { useMemo, useState } from 'react'
import type { Pipeline, PipelineNode, StepState } from '@shared/types'
import { topoSort } from '@shared/graph'
import { C, MONO, ELLIPSIS } from '../theme'
import {
  RailLabel,
  sidePanelShellStyle,
  useCollapseRail
} from './side-panel'
import type { DetailLog, RunState } from '../types'
import { CaretLeft, CaretRight, CheckIcon, ChevronDown, ChevronRight, ChevronUp, PlayIcon, Spinner, StatusMark, StopIcon } from './icons'

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

const PIPELINE_PANEL_WIDTH = 300

interface Status {
  label: string
  color: string
}

function statusOf(run: RunState | undefined): Status {
  if (!run) return { label: 'Not run', color: C.textMuted }
  if (run.status === 'running') return { label: 'Running', color: C.accent }
  if (run.status === 'cancelled') return { label: 'Cancelled', color: C.textMuted }
  if (run.status === 'pass') return { label: 'Passed', color: C.green }
  return { label: 'Failed', color: C.red }
}

function runStatusColor(status: string | undefined, idle: string = C.faint): string {
  if (status === 'running') return C.accent
  if (status === 'pass') return C.green
  if (status === 'fail') return C.red
  return idle
}

function stepLabel(state: StepState | undefined): string {
  if (!state || state === 'pending') return 'Pending'
  if (state === 'skip') return 'Skipped'
  return ''
}

function CollapsedRail({
  shellStyle,
  pipelines,
  runs,
  selected,
  running,
  onSetCollapsed,
  onSelect,
  onStop,
  setExpanded
}: {
  shellStyle: React.CSSProperties
  pipelines: Pipeline[]
  runs: Record<string, RunState>
  selected: Pipeline | null
  running: Pipeline | undefined
  onSetCollapsed: (collapsed: boolean) => void
  onSelect: (id: string) => void
  onStop: (id: string) => void
  setExpanded: (id: string) => void
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
          color: C.textMuted
        }}
      >
        <CaretLeft />
      </button>
      <div style={{ width: 22, height: 1, background: C.border }} />

      {running ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <Spinner size={16} />
          <RailLabel color={C.text} weight={500}>
            {running.name}
          </RailLabel>
          <RailLabel color={C.accent}>
            Step {done + 1} of {running.nodes.length}
          </RailLabel>
          <button
            type="button"
            className="bf-focus bf-icon-btn"
            onClick={() => onStop(running.id)}
            title="Stop pipeline"
            aria-label={`Stop ${running.name}`}
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              border: 0,
              background: C.red,
              display: 'grid',
              placeItems: 'center',
              cursor: 'pointer'
            }}
          >
            <StopIcon size={12} />
          </button>
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
            <RailLabel color={C.textMuted}>{statusOf(sel).label}</RailLabel>
          </div>
        )
      )}

      <span style={{ flex: 1 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, alignItems: 'center' }}>
        {pipelines.map((p) => {
          const st = runs[p.id]
          return (
            <button
              key={p.id}
              type="button"
              className="bf-focus"
              onClick={() => {
                onSelect(p.id)
                setExpanded(p.id)
                onSetCollapsed(false)
              }}
              title={`${p.name} — ${statusOf(st).label}`}
              aria-label={`${p.name}: ${statusOf(st).label}`}
              style={{
                width: 10,
                height: 10,
                padding: 0,
                border: 'none',
                borderRadius: '50%',
                cursor: 'pointer',
                background: runStatusColor(st?.status, C.border)
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
        borderBottom: isLast ? 'none' : '1px solid #3E3E3A',
        color: !state || state === 'pending' ? C.textMuted : C.text,
        background: state === 'running' ? 'rgba(214, 242, 58,.07)' : 'transparent'
      }}
    >
      <span
        title={node.cmd}
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11,
          ...ELLIPSIS
        }}
      >
        {node.name}
      </span>
      <span style={{ fontSize: 11, color: C.textMuted, flex: 'none' }}>{stepLabel(state)}</span>
      {state === 'pass' && <StatusMark done size={18} />}
      {state === 'running' && <Spinner style={{ flex: 'none' }} />}
      {state === 'fail' && (
        <span style={{ fontSize: 12, fontWeight: 700, color: C.red, flex: 'none' }}>✗</span>
      )}
      {(!state || state === 'pending') && <StatusMark size={18} />}
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
  const nodes = useMemo(() => topoSort(pipeline.nodes) ?? pipeline.nodes, [pipeline.nodes])
  const doneCount = nodes.filter((n) => run?.stepResults[n.id] === 'pass').length

  return (
    <div
      onContextMenu={onContextMenu}
      style={{
        borderRadius: 12,
        background: isSel ? C.panel : C.sidebar,
        border: `1px solid ${isSel ? C.accent : C.border}`,
        boxShadow: isSel ? '0 0 0 1px rgba(214, 242, 58,.25)' : 'none'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '10px 9px'
        }}
      >
        {isRunning ? (
          <button
            type="button"
            className="bf-focus"
            onClick={(e) => {
              e.stopPropagation()
              onStop()
            }}
            title="Stop run"
            aria-label={`Stop ${pipeline.name}`}
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              border: 'none',
              background: C.red,
              display: 'grid',
              placeItems: 'center',
              flex: 'none',
              cursor: 'pointer'
            }}
          >
            <StopIcon size={10} />
          </button>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRun()
            }}
            title="Run pipeline"
            aria-label={`Run ${pipeline.name}`}
            className="bf-focus bf-runbtn"
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              border: `1.5px solid ${run?.status === 'pass' ? C.accent : runStatusColor(run?.status)}`,
              background: run?.status === 'pass' ? C.accent : 'transparent',
              color: C.accentInk,
              display: 'grid',
              placeItems: 'center',
              flex: 'none',
              cursor: 'pointer'
            }}
          >
            {run?.status === 'pass' && (
              <span className="bf-runbtn-check">
                <CheckIcon size={11} color={C.accentInk} />
              </span>
            )}
            <span className="bf-runbtn-play" style={{ display: 'none' }}>
              <PlayIcon size={8} />
            </span>
          </button>
        )}
        <button
          type="button"
          className="bf-focus"
          onClick={() => {
            onSelect()
            onToggleExpand()
          }}
          aria-expanded={isExp}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            border: 'none',
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
            textAlign: 'left',
            fontFamily: 'inherit',
            color: 'inherit'
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: '100%'
            }}
          >
            {pipeline.name}
            {pipeline.mandatory && (
              <span
                title="Mandatory in Chat — always runs when the agent changes code"
                style={{
                  marginLeft: 6,
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: C.accent,
                  verticalAlign: 'middle'
                }}
              >
                Required
              </span>
            )}
          </span>
          <span style={{ fontSize: 12, marginTop: 3, color: st.color }}>{st.label}</span>
        </button>
        <span style={{ fontSize: 10, color: C.textMuted, flex: 'none' }}>
          {doneCount} / {nodes.length} steps
        </span>
        {isExp && <ChevronUp style={{ flex: 'none' }} />}
      </div>

      {isExp && (
        <div style={{ padding: '0 8px 8px' }}>
          <div style={{ overflow: 'hidden' }}>
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
  const [logsOpen, setLogsOpen] = useState(true)
  return (
    <div
      style={{
        flex: logsOpen ? 1 : 'none',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderTop: '1px solid #3E3E3A',
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
        <span style={{ fontSize: 13, fontWeight: 600 }}>{selected.name}</span>
      </div>
      <div style={{ flex: 'none', fontSize: 12, marginTop: 4, marginLeft: 18, color: selStatus.color }}>
        {selRun ? selRun.label : 'Not run'}
      </div>

      <div
        style={{
          flex: logsOpen ? 1 : 'none',
          minHeight: 0,
          marginTop: 13,
          display: 'flex',
          flexDirection: 'column',
          background: C.sidebar,
          border: '1px solid #3E3E3A',
          borderRadius: 6,
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
            color: C.textMuted,
            marginTop: 4,
            wordBreak: 'break-all'
          }}
        >
          {current?.cmd ?? ''}
        </div>
        <button
          type="button"
          className="bf-focus"
          aria-expanded={logsOpen}
          onClick={() => setLogsOpen((v) => !v)}
          title={logsOpen ? 'Collapse logs' : 'Expand logs'}
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 10,
            fontSize: 11,
            fontWeight: 600,
            color: C.textMuted,
            padding: 0,
            border: 0,
            background: 'transparent',
            fontFamily: 'inherit',
            cursor: 'pointer'
          }}
        >
          <span>Logs</span>
          {logsOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
        {logsOpen && (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              marginTop: 13,
              background: C.terminal,
              borderRadius: 8,
              padding: '12px 13px',
              display: 'flex',
              flexDirection: 'column',
              gap: 7,
              overflowY: 'auto'
            }}
          >
            {logs.slice(-4).map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: 14, fontFamily: MONO, fontSize: 11 }}>
                <span style={{ color: C.faint, flex: 'none' }}>{l.t}</span>
                <span style={{ color: l.color, minWidth: 0, overflowWrap: 'anywhere' }}>{l.text}</span>
              </div>
            ))}
          </div>
        )}
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
          borderRadius: 6,
          border: '1px solid rgba(255, 98, 90, 0.35)',
          background: 'rgba(255, 98, 90, 0.1)',
          color: C.red,
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer'
        }}
      >
        <StopIcon size={12} color={C.red} />
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
          borderRadius: 6,
          border: '1px solid rgba(255, 98, 90, 0.35)',
          background: 'rgba(255, 98, 90, 0.1)',
          color: C.red,
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer'
        }}
      >
        <StopIcon size={12} color={C.red} />
        <span>Stop pipeline</span>
      </button>
    )
  }
  return (
    <button
      type="button"
      className="bf-focus bf-linkish"
      onClick={onOpenTerminal}
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '10px 0 7px',
        color: C.textRow,
        cursor: 'pointer',
        border: 'none',
        background: 'transparent',
        fontFamily: 'inherit'
      }}
    >
      <span style={{ fontSize: 11 }}>View logs</span>
      <ChevronRight />
    </button>
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
          background: C.sidebar,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
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
  const { showRail, onWidthTransitionEnd } = useCollapseRail(collapsed)
  const running = pipelines.find((p) => runs[p.id]?.status === 'running')
  const shellStyle = sidePanelShellStyle(collapsed, { panelWidth: PIPELINE_PANEL_WIDTH })
  const selRun = selected ? runs[selected.id] : undefined
  const selStatus = statusOf(selRun)
  const selNodes = useMemo(
    () => (selected ? topoSort(selected.nodes) ?? selected.nodes : []),
    [selected]
  )
  const current = useMemo(
    () =>
      selNodes.find((n) => selRun?.stepResults[n.id] === 'running') ??
      [...selNodes].reverse().find((n) => selRun?.stepResults[n.id] === 'fail') ??
      selNodes[0],
    [selNodes, selRun]
  )

  if (showRail) {
    return (
      <CollapsedRail
        shellStyle={shellStyle}
        pipelines={pipelines}
        runs={runs}
        selected={selected}
        running={running}
        onSetCollapsed={onSetCollapsed}
        onSelect={onSelect}
        onStop={onStop}
        setExpanded={setExpanded}
      />
    )
  }

  return (
    <div
      className="bf-side-panel"
      style={shellStyle}
      onTransitionEnd={onWidthTransitionEnd}
    >
      <div
        style={{
          width: PIPELINE_PANEL_WIDTH,
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
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.09em',
            color: C.textMuted,
            flex: 1
          }}
        >
          PIPELINES
        </span>
        <button
          type="button"
          className="bf-focus bf-newpipe"
          onClick={onNew}
          title="New pipeline"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '5px 10px',
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            fontSize: 11,
            fontWeight: 600,
            color: C.text,
            cursor: 'pointer',
            fontFamily: 'inherit'
          }}
        >
          <span style={{ fontSize: 13, lineHeight: 1 }}>+</span>
          <span>New Pipeline</span>
        </button>
        <button
          type="button"
          className="bf-focus bf-icon-btn"
          onClick={() => onSetCollapsed(true)}
          title="Collapse panel"
          aria-label="Collapse pipelines panel"
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            border: 0,
            background: 'transparent',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            color: C.textMuted
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
