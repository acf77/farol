import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatBytes, memoryLevel, procLabel, type AttributedProc, type ProcSnapshot, type WorktreeUsage } from '@shared/proc'
import { shortPath } from '@shared/project-groups'
import { C, MONO, ELLIPSIS } from '../theme'

const api = window.farol

const POPOVER_WIDTH = 440
const LEVEL_COLOR = { ok: C.faint, warn: C.yellow, alert: C.red } as const

export function useProcSnapshot(): ProcSnapshot | null {
  const [snapshot, setSnapshot] = useState<ProcSnapshot | null>(null)
  useEffect(() => {
    let live = true
    void api.proc.snapshot().then((s) => live && setSnapshot(s))
    const off = api.proc.onSnapshot(setSnapshot)
    return () => {
      live = false
      off()
    }
  }, [])
  return snapshot
}

function colorOf(bytes: number, snapshot: ProcSnapshot): string {
  return LEVEL_COLOR[memoryLevel(bytes, snapshot.warnGb ?? 2, snapshot.alertGb ?? 4)]
}

const approx = (snapshot: ProcSnapshot): string => (snapshot.approximate ? '≈' : '')

const chipStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flex: 'none',
  border: 0,
  background: 'transparent',
  cursor: 'pointer',
  padding: '1px 4px',
  borderRadius: 5,
  fontFamily: MONO,
  fontSize: 11
}

/** A worktree row's total, with a ⚠ when a finished session left processes running. */
export function MemoryChip({
  usage,
  snapshot,
  onOpen
}: {
  usage: WorktreeUsage
  snapshot: ProcSnapshot
  onOpen: (anchor: HTMLElement) => void
}) {
  if (usage.footprint <= 0 && !usage.leftoverCount) return null
  const total = `${approx(snapshot)}${formatBytes(usage.footprint)}`
  const tip = usage.leftoverSummary || `Agent memory${snapshot.approximate ? ' (approximate)' : ''}`
  return (
    <button
      type="button"
      className="bf-focus bf-icon-btn"
      title={tip}
      aria-label={`${tip}: ${total}`}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(e.currentTarget)
      }}
      style={{ ...chipStyle, color: colorOf(usage.footprint, snapshot) }}
    >
      {usage.leftoverCount > 0 && (
        <span aria-hidden style={{ color: C.yellow }}>
          ⚠
        </span>
      )}
      {total}
    </button>
  )
}

/** "Agents: 5.4 GB", with the worktrees behind it one click away. */
export function AgentsFooter({
  snapshot,
  onOpen
}: {
  snapshot: ProcSnapshot
  onOpen: (worktree: string, anchor: HTMLElement) => void
}) {
  const [open, setOpen] = useState(false)
  const leftovers = snapshot.worktrees.some((w) => w.leftoverCount > 0)
  return (
    <div style={{ flex: 'none', padding: '4px 10px', borderTop: '1px solid oklch(1 0 0 / 0.06)' }}>
      <button
        type="button"
        className="bf-focus bf-icon-btn"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title="Memory used by agent sessions and what they started"
        style={{ ...chipStyle, width: '100%', padding: '5px 4px', color: colorOf(snapshot.totalFootprint, snapshot) }}
      >
        {leftovers && (
          <span aria-hidden style={{ color: C.yellow }}>
            ⚠
          </span>
        )}
        <span style={{ flex: 1, textAlign: 'left', color: C.textMuted, fontFamily: 'inherit' }}>Agents</span>
        {approx(snapshot)}
        {formatBytes(snapshot.totalFootprint)}
      </button>
      {open &&
        snapshot.worktrees.map((w) => (
          <button
            key={w.worktree}
            type="button"
            className="bf-focus bf-icon-btn"
            onClick={(e) => onOpen(w.worktree, e.currentTarget)}
            style={{ ...chipStyle, width: '100%', color: colorOf(w.footprint, snapshot) }}
          >
            <span style={{ flex: 1, minWidth: 0, textAlign: 'left', color: C.faint, ...ELLIPSIS }}>{shortPath(w.worktree)}</span>
            {w.leftoverCount > 0 && <span style={{ color: C.yellow }}>⚠</span>}
            {formatBytes(w.footprint)}
          </button>
        ))}
    </div>
  )
}

function outcome(results: Awaited<ReturnType<typeof api.proc.kill>>[]): string {
  const refused = results.find((r) => !r.ok)
  if (refused) return refused.message ?? 'Could not stop it.'
  const stopped = results.reduce((n, r) => n + r.terminated + r.killed, 0)
  const forced = results.reduce((n, r) => n + r.killed, 0)
  return `Stopped ${stopped}${forced ? ` (${forced} needed force)` : ''}.`
}

const COLUMNS = '1fr 52px 62px 44px 72px 22px'
const cell: React.CSSProperties = { fontFamily: MONO, fontSize: 11.5, ...ELLIPSIS }

/** Every process an agent session of this worktree started, with what to stop. */
export function MemoryPopover({
  usage,
  snapshot,
  anchor,
  onClose
}: {
  usage: WorktreeUsage
  snapshot: ProcSnapshot
  anchor: HTMLElement
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [ports, setPorts] = useState<Record<number, number[]>>({})
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const procs = useMemo(
    () => usage.sessions.flatMap((s) => s.procs).sort((a, b) => b.footprint - a.footprint),
    [usage]
  )
  const leftovers = usage.sessions.flatMap((s) => s.leftovers.filter((p) => p.owned))
  const byFolderOnly = usage.sessions.flatMap((s) => s.leftovers).length - leftovers.length
  const working = new Set(usage.sessions.filter((s) => s.state === 'working').map((s) => s.sessionId))
  const sessionKey = usage.sessions.map((s) => s.sessionId).join()
  const pidKey = procs.map((p) => p.pid).join()

  // Ports are read when the view opens and whenever the set of processes changes.
  useEffect(() => {
    let live = true
    const ids = sessionKey.split(',').filter(Boolean)
    void Promise.all(ids.map((id) => api.proc.ports(id))).then((all) => {
      if (live && pidKey) setPorts(Object.assign({}, ...all) as Record<number, number[]>)
    })
    return () => {
      live = false
    }
  }, [sessionKey, pidKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (!ref.current?.contains(target) && !anchor.contains(target)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [anchor, onClose])

  const rect = anchor.getBoundingClientRect()
  const left = Math.max(8, Math.min(rect.right + 8, window.innerWidth - POPOVER_WIDTH - 8))
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - 380))

  const stop = async (jobs: Promise<Awaited<ReturnType<typeof api.proc.kill>>>[]): Promise<void> => {
    setBusy(true)
    setConfirm(false)
    setNote(outcome(await Promise.all(jobs)))
    setBusy(false)
  }
  const killLeftovers = (): Promise<void> =>
    stop(usage.sessions.filter((s) => s.leftovers.some((p) => p.owned)).map((s) => api.proc.kill(s.sessionId)))
  const killOne = (p: AttributedProc): Promise<void> => stop([api.proc.kill(p.sessionId, p.pid)])

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Agent memory"
      style={{
        position: 'fixed',
        left,
        top,
        width: POPOVER_WIDTH,
        maxHeight: window.innerHeight - top - 8,
        overflow: 'auto',
        zIndex: 200,
        padding: 12,
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
        color: C.text,
        fontSize: 12
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <strong style={{ flex: 1, minWidth: 0, fontWeight: 600, ...ELLIPSIS }}>{shortPath(usage.worktree)}</strong>
        <span style={{ fontFamily: MONO, color: colorOf(usage.footprint, snapshot) }}>
          {approx(snapshot)}
          {formatBytes(usage.footprint)}
        </span>
      </div>
      {snapshot.approximate && (
        <div style={{ color: C.faint, marginBottom: 8 }}>Approximate: RSS from ps. The helper is not running.</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: COLUMNS, gap: 8, color: C.faint, fontSize: 11, paddingBottom: 4 }}>
        <span>Process</span>
        <span>PID</span>
        <span>Memory</span>
        <span>CPU</span>
        <span>Ports</span>
        <span />
      </div>
      {procs.map((p) => {
        const protectedRoot = p.isRoot && working.has(p.sessionId)
        return (
          <div key={p.pid} style={{ display: 'grid', gridTemplateColumns: COLUMNS, gap: 8, alignItems: 'center', padding: '3px 0' }}>
            <span style={cell} title={p.args || p.name}>
              {procLabel(p)}
              {p.isRoot ? ' (agent)' : ''}
              {p.via === 'cwd' && !p.owned ? ' (by folder)' : ''}
            </span>
            <span style={{ ...cell, color: C.faint }}>{p.pid}</span>
            <span style={cell}>{formatBytes(p.footprint)}</span>
            <span style={cell}>{Math.round(p.cpu)}%</span>
            <span style={{ ...cell, color: C.textMuted }}>{(ports[p.pid] ?? []).map((n) => `:${n}`).join(' ')}</span>
            <button
              type="button"
              className="bf-focus bf-icon-btn"
              disabled={busy || protectedRoot}
              title={protectedRoot ? 'The agent is working' : `Stop ${procLabel(p)}`}
              aria-label={`Stop ${procLabel(p)} ${p.pid}`}
              onClick={() => void killOne(p)}
              style={{ ...chipStyle, padding: 0, justifyContent: 'center', color: C.faint, opacity: protectedRoot ? 0.3 : 1 }}
            >
              ×
            </button>
          </div>
        )
      })}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, borderTop: `1px solid ${C.hair}`, paddingTop: 10 }}>
        <span style={{ flex: 1, color: note ? C.textSoft : C.faint }}>
          {busy
            ? 'Stopping…'
            : (note ??
              (byFolderOnly
                ? `${usage.leftoverSummary}. ${byFolderOnly} found by folder only: stop with × if they are yours.`
                : leftovers.length
                  ? usage.leftoverSummary
                  : 'Nothing left running.'))}
        </span>
        {!!leftovers.length && !confirm && (
          <button type="button" className="bf-focus" disabled={busy} onClick={() => setConfirm(true)} style={actionStyle(C.yellow)}>
            Kill leftovers
          </button>
        )}
      </div>

      {confirm && (
        <div style={{ marginTop: 8, padding: 8, borderRadius: 8, background: 'oklch(1 0 0 / 0.04)' }}>
          <div style={{ marginBottom: 6 }}>These will be stopped (SIGTERM, then SIGKILL after 3 s):</div>
          {leftovers.map((p) => (
            <div key={p.pid} style={{ ...cell, color: C.textMuted }}>
              {procLabel(p)} · {p.pid} · {formatBytes(p.footprint)}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="bf-focus" onClick={() => setConfirm(false)} style={actionStyle(C.textMuted)}>
              Cancel
            </button>
            <button type="button" className="bf-focus" onClick={() => void killLeftovers()} style={actionStyle(C.red)}>
              Stop {leftovers.length}
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body
  )
}

function actionStyle(color: string): React.CSSProperties {
  return {
    border: `1px solid ${color}`,
    background: 'transparent',
    color,
    borderRadius: 6,
    padding: '3px 10px',
    fontSize: 11.5,
    cursor: 'pointer'
  }
}
