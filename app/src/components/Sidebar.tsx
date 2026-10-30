import { useMemo, useState } from 'react'
import type { GitStatus, Pipeline, PipelineNode, StepState } from '@shared/types'
import { topoSort } from '@shared/graph'
import { C, MONO, ELLIPSIS } from '../theme'
import { SIDE_RAIL_WIDTH, SideCard, sideCardStyle, sidePanelShellStyle, useCollapseRail } from './side-panel'
import type { DetailLog, RunState } from '../types'
import FilesChanged from './FilesChanged'
import TurnPanel from './chat/TurnPanel'
import { BranchIcon, ChevronLeft, ChevronRight, ChevronUp, Spinner } from './icons'

interface Props {
  pipelines: Pipeline[]
  /** Branch the runs below belong to. */
  branch: string
  /** Runs for the branch currently checked out, keyed by pipeline id. */
  runs: Record<string, RunState>
  logs: DetailLog[]
  /** Working-tree status for the Files changed section. */
  gitStatus: GitStatus | null
  /** Open a changed file in the Code pane. */
  onOpenFile: (path: string) => void
  selected: Pipeline | null
  onSelect: (id: string) => void
  onNew: () => void
  onRun: (id: string) => void
  onStop: (id: string) => void
  onEdit: (p: Pipeline) => void
  onDelete: (id: string) => void
  /** Hand the failed run to Chat. */
  onFix: (id: string) => void
  onOpenTerminal: () => void
  collapsed: boolean
  onSetCollapsed: (collapsed: boolean) => void
  /** The open chat, for its turn checkpoints; null when there is none. */
  turns: { taskId: string; cwd: string; busy: boolean } | null
}

const PIPELINE_PANEL_WIDTH = 320
const SOFT = 'oklch(1 0 0 / 0.06)'
const FAIL_TEXT = 'oklch(0.72 0.17 25)'

type PipelineStatus = 'idle' | 'running' | 'pass' | 'fail' | 'cancelled'

function statusOf(run: RunState | undefined): PipelineStatus {
  return run?.status ?? 'idle'
}

/** The design's status swatch: lime run-ring, red, hollow or muted. */
function dotColor(status: PipelineStatus | StepState | undefined): string {
  if (status === 'pass' || status === 'running') return C.accent
  if (status === 'fail') return C.red
  if (status === 'cancelled') return C.faint
  return C.border
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function nodesOf(pipeline: Pipeline): PipelineNode[] {
  return topoSort(pipeline.nodes) ?? pipeline.nodes
}

function subLine(pipeline: Pipeline, run: RunState | undefined): { text: string; color: string } {
  const line = runLine(pipeline, run)
  return pipeline.mandatory ? { ...line, text: `Required · ${line.text}` } : line
}

function runLine(pipeline: Pipeline, run: RunState | undefined): { text: string; color: string } {
  const nodes = nodesOf(pipeline)
  const status = statusOf(run)
  if (!run || status === 'idle') return { text: 'Not run on this branch', color: C.faint }
  if (status === 'running') {
    const index = Math.max(0, nodes.findIndex((n) => run.stepResults[n.id] === 'running'))
    return { text: `Step ${index + 1} of ${nodes.length} · ${nodes[index]?.name ?? ''}`, color: C.accent }
  }
  if (status === 'pass') return { text: `Passed · ${ago(run.startedAt)}`, color: C.faint }
  if (status === 'fail') return { text: `Failed · ${ago(run.startedAt)}`, color: FAIL_TEXT }
  const done = nodes.filter((n) => run.stepResults[n.id] === 'pass').length
  return { text: `Cancelled at ${done}/${nodes.length} · ${ago(run.startedAt)}`, color: C.faint }
}

/** The run/stop control: plain check when passed, red ringed cross when failed, ring otherwise. */
function StatusButton({ name, status, onRun, onStop }: { name: string; status: PipelineStatus; onRun: () => void; onStop: () => void }) {
  const running = status === 'running'
  return (
    <button
      type="button"
      className="bf-focus bf-icon-btn"
      onClick={(e) => {
        e.stopPropagation()
        if (running) onStop()
        else onRun()
      }}
      title={running ? 'Stop' : 'Run'}
      aria-label={`${running ? 'Stop' : 'Run'} ${name}`}
      style={{ width: 22, height: 22, flex: 'none', display: 'grid', placeItems: 'center', border: 0, borderRadius: '50%', background: 'transparent', cursor: 'pointer', padding: 0 }}
    >
      {status === 'pass' && (
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke={C.textSoft} strokeWidth="1.6" aria-hidden><path d="M2.5 6.2 5 8.5l4.5-5" /></svg>
      )}
      {status === 'fail' && (
        <span style={{ width: 16, height: 16, boxSizing: 'border-box', borderRadius: '50%', border: `1.5px solid ${FAIL_TEXT}`, display: 'grid', placeItems: 'center' }}>
          <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke={FAIL_TEXT} strokeWidth="1.8" aria-hidden><path d="M2 2l6 6M8 2 2 8" /></svg>
        </span>
      )}
      {(status === 'idle' || status === 'cancelled') && (
        <span style={{ width: 16, height: 16, borderRadius: '50%', border: `1.5px solid ${C.fainter}` }} />
      )}
      {running && <Spinner size={16} />}
    </button>
  )
}

function CollapsedRail({
  shellStyle,
  pipelines,
  runs,
  onSetCollapsed,
  onSelect,
  setExpanded
}: {
  shellStyle: React.CSSProperties
  pipelines: Pipeline[]
  runs: Record<string, RunState>
  onSetCollapsed: (collapsed: boolean) => void
  onSelect: (id: string) => void
  setExpanded: (id: string) => void
}) {
  return (
    <div className="bf-side-panel" style={{ ...shellStyle, background: C.app, borderLeft: 'none', padding: 8 }}>
    <div style={{ ...sideCardStyle, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '12px 0' }}>
      <button
        type="button"
        className="bf-focus bf-icon-btn"
        onClick={() => onSetCollapsed(false)}
        title="Show pipelines"
        aria-label="Show pipelines"
        style={railButton}
      >
        <ChevronLeft size={10} color={C.textMuted} />
      </button>
      {pipelines.map((p) => {
        const status = statusOf(runs[p.id])
        const hollow = status === 'idle' || status === 'cancelled'
        return (
          <button
            key={p.id}
            type="button"
            className="bf-focus bf-icon-btn"
            onClick={() => {
              onSelect(p.id)
              setExpanded(p.id)
              onSetCollapsed(false)
            }}
            title={p.name}
            aria-label={`${p.name}: ${status === 'idle' ? 'not run' : status}`}
            style={railButton}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: hollow ? 'transparent' : dotColor(status),
                border: hollow ? `1.5px solid ${C.faint}` : 'none',
                animation: status === 'running' ? 'bfpulse 1.1s ease-in-out infinite' : 'none'
              }}
            />
          </button>
        )
      })}
    </div>
    </div>
  )
}

const railButton: React.CSSProperties = {
  width: 28,
  height: 28,
  display: 'grid',
  placeItems: 'center',
  border: 0,
  borderRadius: 7,
  background: 'transparent',
  cursor: 'pointer',
  padding: 0
}

function StepRow({ node, state }: { node: PipelineNode; state: StepState | undefined }) {
  const pending = !state || state === 'pending' || state === 'skip'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
      <span style={{ width: 6, height: 6, flex: 'none', borderRadius: '50%', background: dotColor(state) }} />
      <span title={node.cmd} style={{ flex: 1, minWidth: 0, fontSize: 12, color: pending ? C.faint : C.textSoft, ...ELLIPSIS }}>
        {node.name}
      </span>
      <span style={{ flex: 'none', fontFamily: MONO, fontSize: 10.5, color: C.faint }}>
        {state === 'running' ? 'running' : state === 'skip' ? 'skipped' : ''}
      </span>
    </div>
  )
}

function PipelineCard({
  pipeline,
  run,
  isExp,
  onSelect,
  onToggleExpand,
  onRun,
  onStop,
  onFix,
  onEdit,
  onContextMenu
}: {
  pipeline: Pipeline
  run: RunState | undefined
  isExp: boolean
  onSelect: () => void
  onToggleExpand: () => void
  onRun: () => void
  onStop: () => void
  onFix: () => void
  onEdit: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const status = statusOf(run)
  const running = status === 'running'
  const nodes = useMemo(() => nodesOf(pipeline), [pipeline])
  const sub = subLine(pipeline, run)

  return (
    <div onContextMenu={onContextMenu} style={{ borderRadius: 10 }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExp}
        className="bf-focus bf-pipe-row"
        onClick={() => {
          onSelect()
          onToggleExpand()
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          onSelect()
          onToggleExpand()
        }}
        style={{ display: 'flex', alignItems: 'center', gap: 11, padding: 10, borderRadius: 10, cursor: 'pointer' }}
      >
        <StatusButton name={pipeline.name} status={status} onRun={onRun} onStop={onStop} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            <span title={pipeline.name} style={{ fontSize: 13, fontWeight: 500, ...ELLIPSIS }}>{pipeline.name}</span>
          </div>
          <div style={{ fontSize: 11.5, marginTop: 2, color: sub.color, ...ELLIPSIS }}>{sub.text}</div>
        </div>
      </div>

      {isExp && (
        <div style={{ padding: '0 10px 10px 43px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {nodes.map((n) => (
              <StepRow key={n.id} node={n} state={run?.stepResults[n.id]} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="bf-focus"
              onClick={running ? onStop : onRun}
              style={{
                ...cardButton,
                fontWeight: 600,
                background: running ? 'oklch(0.69 0.2 25 / 0.14)' : C.accent,
                color: running ? 'oklch(0.76 0.17 25)' : C.accentInk
              }}
            >
              {running ? 'Stop' : status === 'idle' ? 'Run' : 'Run again'}
            </button>
            {status === 'fail' && (
              <button
                type="button"
                className="bf-focus bf-ai-btn"
                onClick={onFix}
                style={{ ...cardButton, background: 'oklch(0.73 0.16 300 / 0.12)', color: C.purpleSoft }}
              >
                Fix in Chat
              </button>
            )}
            <button type="button" className="bf-focus bf-icon-btn" onClick={onEdit} style={{ ...cardButton, background: 'transparent', color: C.textRow }}>
              Edit
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const cardButton: React.CSSProperties = {
  padding: '5px 10px',
  border: 'none',
  borderRadius: 6,
  fontFamily: 'inherit',
  fontSize: 11.5,
  fontWeight: 500,
  cursor: 'pointer'
}

function OutputPane({
  name,
  logs,
  onOpenTerminal
}: {
  name: string
  logs: DetailLog[]
  onOpenTerminal: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <SideCard label="Output">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        className="bf-focus"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          setOpen((v) => !v)
        }}
        style={{ flex: 'none', height: 36, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px 0 16px', cursor: 'pointer' }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', color: C.faint }}>OUTPUT</span>
        <span title={name} style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: C.textMuted, ...ELLIPSIS }}>{name}</span>
        <button
          type="button"
          className="bf-focus bf-icon-btn"
          onClick={(e) => {
            e.stopPropagation()
            onOpenTerminal()
          }}
          style={{ fontSize: 11.5, color: C.textRow, padding: '3px 6px', borderRadius: 5, border: 0, background: 'transparent', fontFamily: 'inherit', cursor: 'pointer' }}
        >
          Open in terminal
        </button>
        <ChevronUp size={10} color={C.faint} style={{ flex: 'none', transform: open ? 'rotate(180deg)' : 'none' }} />
      </div>
      {open && (
        <div
          role="log"
          style={{ maxHeight: 210, overflow: 'auto', margin: '0 8px 8px', padding: '10px 12px', borderRadius: 8, background: C.app, display: 'flex', flexDirection: 'column', gap: 5, fontFamily: MONO, fontSize: 11, lineHeight: 1.5 }}
        >
          {logs.slice(-8).map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 12 }}>
              <span style={{ flex: 'none', color: C.fainter }}>{l.t}</span>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere', color: l.color }}>{l.text}</span>
            </div>
          ))}
        </div>
      )}
    </SideCard>
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
  branch,
  runs,
  logs,
  gitStatus,
  onOpenFile,
  selected,
  onSelect,
  onNew,
  onRun,
  onStop,
  onEdit,
  onDelete,
  onFix,
  onOpenTerminal,
  collapsed,
  onSetCollapsed,
  turns
}: Props) {
  const [expanded, setExpanded] = useState<string | null>(selected?.id ?? null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const { showRail, onWidthTransitionEnd } = useCollapseRail(collapsed)
  const shellStyle = sidePanelShellStyle(collapsed, { panelWidth: PIPELINE_PANEL_WIDTH, railWidth: SIDE_RAIL_WIDTH + 16, edge: 'left' })
  const required = pipelines.filter((p) => p.mandatory && p.nodes.length)
  const canRunRequired = required.some((p) => runs[p.id]?.status !== 'running')

  if (showRail) {
    return (
      <CollapsedRail
        shellStyle={shellStyle}
        pipelines={pipelines}
        runs={runs}
        onSetCollapsed={onSetCollapsed}
        onSelect={onSelect}
        setExpanded={setExpanded}
      />
    )
  }

  return (
    <div className="bf-side-panel" style={{ ...shellStyle, background: C.app, borderLeft: 'none' }} onTransitionEnd={onWidthTransitionEnd}>
      <div style={{ width: PIPELINE_PANEL_WIDTH, boxSizing: 'border-box', flex: 1, minHeight: 0, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SideCard label="Pipelines" max={460}>
        <div style={{ position: 'sticky', top: 0, zIndex: 1, background: C.sidebar, display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 10px 12px 16px', borderBottom: `1px solid ${SOFT}`, marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>Pipelines</span>
            <button
              type="button"
              className="bf-focus bf-icon-btn"
              onClick={onNew}
              title="New pipeline"
              aria-label="New pipeline"
              style={{ ...headerButton, color: C.textSoft, fontSize: 16, lineHeight: 1 }}
            >
              +
            </button>
            <button
              type="button"
              className="bf-focus bf-icon-btn"
              onClick={() => onSetCollapsed(true)}
              title="Collapse"
              aria-label="Collapse pipelines panel"
              style={{ ...headerButton, color: C.faint }}
            >
              <ChevronRight size={10} />
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 6 }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 7 }}>
              <BranchIcon size={11} color={C.textMuted} style={{ flex: 'none' }} />
              <span title={branch} style={{ fontFamily: MONO, fontSize: 12, color: C.textSoft, ...ELLIPSIS }}>{branch}</span>
            </div>
            <button
              type="button"
              className="bf-focus bf-hover-fill"
              disabled={!canRunRequired}
              onClick={() => required.filter((p) => runs[p.id]?.status !== 'running').forEach((p) => onRun(p.id))}
              title="Run required pipelines"
              style={{ flex: 'none', height: 26, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 6, borderRadius: 7, background: C.panel, border: `1px solid ${SOFT}`, color: C.textSoft, fontFamily: 'inherit', fontSize: 11.5, fontWeight: 500, cursor: canRunRequired ? 'pointer' : 'default', opacity: canRunRequired ? 1 : 0.4 }}
            >
              <svg width="7" height="8" viewBox="0 0 8 9" fill="currentColor" aria-hidden><path d="M1 .8v7.4L7.2 4.5Z" /></svg>
              <span>Run required</span>
            </button>
          </div>
        </div>

        <div style={{ padding: '2px 8px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {pipelines.map((p) => (
            <PipelineCard
              key={p.id}
              pipeline={p}
              run={runs[p.id]}
              isExp={p.id === expanded}
              onSelect={() => onSelect(p.id)}
              onToggleExpand={() => setExpanded((cur) => (cur === p.id ? null : p.id))}
              onRun={() => onRun(p.id)}
              onStop={() => onStop(p.id)}
              onFix={() => onFix(p.id)}
              onEdit={() => onEdit(p)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ id: p.id, x: e.clientX, y: e.clientY })
              }}
            />
          ))}
          {!pipelines.length && (
            <div style={{ padding: '10px 8px', fontSize: 12, color: C.faint, lineHeight: 1.5 }}>
              No pipelines yet. Use + to create one.
            </div>
          )}
        </div>
        </SideCard>

        <FilesChanged status={gitStatus} onOpen={onOpenFile} />

        {selected && logs.length > 0 && (
          <OutputPane name={selected.name} logs={logs} onOpenTerminal={onOpenTerminal} />
        )}

        {turns && <TurnPanel taskId={turns.taskId} cwd={turns.cwd} busy={turns.busy} />}
      </div>

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

const headerButton: React.CSSProperties = {
  width: 26,
  height: 26,
  flex: 'none',
  display: 'grid',
  placeItems: 'center',
  border: 0,
  borderRadius: 7,
  background: 'transparent',
  cursor: 'pointer'
}
