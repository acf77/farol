import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatBytes, memoryLevel, meterSegments, type AttributedProc, type ProcSnapshot, type WorktreeUsage } from '@shared/proc'
import { shortPath } from '@shared/project-groups'
import { C, MONO, ELLIPSIS } from '../theme'

const api = window.farol

const POPOVER_WIDTH = 250
const POPOVER_ROWS = 4
/** How long the pointer may leave the meter or the popover before the popover closes. */
const LEAVE_DELAY_MS = 180
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

/** Which worktree's popover is open. It opens on hover and closes a moment after the pointer leaves. */
export function useMemoryHover() {
  const [view, setView] = useState<{ path: string; anchor: HTMLElement } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const cancel = useCallback(() => window.clearTimeout(timer.current), [])
  const open = useCallback(
    (path: string, anchor: HTMLElement) => {
      cancel()
      setView({ path, anchor })
    },
    [cancel]
  )
  const close = useCallback(() => {
    cancel()
    setView(null)
  }, [cancel])
  const leave = useCallback(() => {
    cancel()
    timer.current = window.setTimeout(() => setView(null), LEAVE_DELAY_MS)
  }, [cancel])
  useEffect(() => cancel, [cancel])
  return { view, open, close, leave, cancel }
}

function colorOf(bytes: number, snapshot: ProcSnapshot): string {
  return LEVEL_COLOR[memoryLevel(bytes, snapshot.warnGb ?? 2, snapshot.alertGb ?? 4)]
}

const approx = (snapshot: ProcSnapshot): string => (snapshot.approximate ? '≈' : '')

const METER_COLOR = { ok: C.accent, warn: C.yellow, alert: C.red } as const

const levelOf = (bytes: number, snapshot: ProcSnapshot) => memoryLevel(bytes, snapshot.warnGb ?? 2, snapshot.alertGb ?? 4)

/**
 * A row of eight ticks that light up from the left as memory grows.
 * They turn yellow, then red, with the warn and alert levels. While the agent works, a wave runs through the lit ones.
 */
function MemoryMeter({ bytes, cpu, snapshot }: { bytes: number; cpu: number; snapshot: ProcSnapshot }) {
  const lit = meterSegments(bytes, snapshot.alertGb ?? 4)
  const busy = cpu >= 3
  const color = METER_COLOR[levelOf(bytes, snapshot)]
  return (
    <span aria-hidden style={{ display: 'flex', gap: 2, flex: 'none' }}>
      {Array.from({ length: 8 }, (_, i) => (
        <span
          key={i}
          className={i < lit && busy ? 'bf-mem-seg bf-mem-busy' : 'bf-mem-seg'}
          style={{ width: 3, height: 11, borderRadius: 1, background: i < lit ? color : 'oklch(1 0 0 / 0.14)', '--i': i } as React.CSSProperties}
        />
      ))}
    </span>
  )
}

/** A thin bar of memory up to the alert level, with a tick at the warn level. */
function UsageBar({ bytes, snapshot }: { bytes: number; snapshot: ProcSnapshot }) {
  const alert = snapshot.alertGb ?? 4
  const warn = snapshot.warnGb ?? 2
  const share = Math.min(1, bytes / (alert * 1024 ** 3))
  return (
    <span aria-hidden className="bf-mem-bar">
      <span className="bf-mem-bar-fill" style={{ width: `${Math.max(share * 100, bytes > 0 ? 3 : 0)}%`, background: METER_COLOR[levelOf(bytes, snapshot)] }} />
      <span className="bf-mem-bar-tick" style={{ left: `${Math.min(100, (warn / alert) * 100)}%` }} />
    </span>
  )
}

function WarnIcon() {
  return (
    <svg aria-hidden width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ flex: 'none', color: C.yellow }}>
      <path d="M8 1.8 15 14H1L8 1.8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 6.5v3.2M8 11.6v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

const chipStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  flex: 'none',
  border: 0,
  background: 'transparent',
  cursor: 'default',
  padding: '3px 5px',
  borderRadius: 6,
  fontFamily: MONO,
  fontSize: 10.5
}

/** A worktree row's memory meter. Hover it for details; a ⚠ shows when a finished session left processes running. */
export function MemoryChip({
  usage,
  snapshot,
  onOpen,
  onLeave
}: {
  usage: WorktreeUsage
  snapshot: ProcSnapshot
  onOpen: (anchor: HTMLElement) => void
  onLeave: () => void
}) {
  const label = `Agent memory ${approx(snapshot)}${formatBytes(usage.footprint)}${usage.leftoverSummary ? `. ${usage.leftoverSummary}` : ''}`
  return (
    <button
      type="button"
      className="bf-focus bf-icon-btn bf-mem-chip"
      aria-label={label}
      style={{ ...chipStyle, padding: '0 5px' }}
      onMouseEnter={(e) => onOpen(e.currentTarget)}
      onMouseLeave={onLeave}
      onFocus={(e) => onOpen(e.currentTarget)}
      onBlur={onLeave}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(e.currentTarget)
      }}
    >
      {usage.leftoverCount > 0 && <WarnIcon />}
      <MemoryMeter bytes={usage.footprint} cpu={usage.cpu} snapshot={snapshot} />
    </button>
  )
}

/** "Agents: 5.4 GB", with the worktrees behind it one click away. */
export function AgentsFooter({
  snapshot,
  onOpen,
  onLeave
}: {
  snapshot: ProcSnapshot
  onOpen: (worktree: string, anchor: HTMLElement) => void
  onLeave: () => void
}) {
  const [open, setOpen] = useState(false)
  const leftovers = snapshot.worktrees.some((w) => w.leftoverCount > 0)
  return (
    <div style={{ flex: 'none', padding: '4px 10px', borderTop: '1px solid oklch(1 0 0 / 0.06)' }}>
      <button
        type="button"
        className="bf-focus bf-icon-btn bf-mem-chip"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title="Memory used by agent sessions and what they started"
        style={{ ...chipStyle, cursor: 'pointer', width: '100%', padding: '5px 5px 4px', flexWrap: 'wrap', rowGap: 5, fontSize: 11 }}
      >
        <svg
          aria-hidden
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          style={{ flex: 'none', color: C.faint, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 140ms ease' }}
        >
          <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{ flex: 1, textAlign: 'left', color: C.textMuted, fontFamily: 'inherit' }}>Agents</span>
        {leftovers && <WarnIcon />}
        <MemoryMeter bytes={snapshot.totalFootprint} cpu={snapshot.worktrees.reduce((n, w) => n + w.cpu, 0)} snapshot={snapshot} />
        <span style={{ color: colorOf(snapshot.totalFootprint, snapshot) }}>
          {approx(snapshot)}
          {formatBytes(snapshot.totalFootprint)}
        </span>
        <span style={{ flexBasis: '100%', display: 'flex' }}>
          <UsageBar bytes={snapshot.totalFootprint} snapshot={snapshot} />
        </span>
      </button>
      {open &&
        snapshot.worktrees.map((w) => (
          <button
            key={w.worktree}
            type="button"
            className="bf-focus bf-icon-btn bf-mem-chip"
            onMouseEnter={(e) => onOpen(w.worktree, e.currentTarget)}
            onMouseLeave={onLeave}
            onFocus={(e) => onOpen(w.worktree, e.currentTarget)}
            onBlur={onLeave}
            style={{ ...chipStyle, width: '100%', paddingLeft: 20 }}
          >
            <span style={{ flex: 1, minWidth: 0, textAlign: 'left', color: C.faint, ...ELLIPSIS }}>{shortPath(w.worktree)}</span>
            {w.leftoverCount > 0 && <WarnIcon />}
            <MemoryMeter bytes={w.footprint} cpu={w.cpu} snapshot={snapshot} />
            <span className="bf-mem-size" style={{ minWidth: 44, textAlign: 'right' }}>
              {formatBytes(w.footprint)}
            </span>
          </button>
        ))}
    </div>
  )
}

function outcome(results: Awaited<ReturnType<typeof api.proc.kill>>[]): string {
  const refused = results.find((r) => !r.ok)
  if (refused) return refused.message ?? 'Could not stop it.'
  const stopped = results.reduce((n, r) => n + r.terminated + r.killed, 0)
  return `Stopped ${stopped}.`
}

const row: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '3px 4px',
  borderRadius: 5,
  fontFamily: MONO,
  fontSize: 11.5
}

/** The biggest processes of this worktree's agents, and a way to stop what a finished session left. Short on purpose. */
export function MemoryPopover({
  usage,
  snapshot,
  anchor,
  onClose,
  onEnter,
  onLeave
}: {
  usage: WorktreeUsage
  snapshot: ProcSnapshot
  anchor: HTMLElement
  onClose: () => void
  onEnter: () => void
  onLeave: () => void
}) {
  const ports = useSessionPorts(usage)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const procs = useMemo(() => usage.sessions.flatMap((s) => s.procs).filter((p) => p.isRoot).sort((a, b) => b.footprint - a.footprint), [usage])
  const leftovers = usage.sessions.flatMap((s) => s.leftovers.filter((p) => p.owned))
  const working = new Set(usage.sessions.filter((s) => s.state === 'working').map((s) => s.sessionId))
  const shown = procs.slice(0, POPOVER_ROWS)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const rect = anchor.getBoundingClientRect()
  const left = Math.max(8, Math.min(rect.right + 8, window.innerWidth - POPOVER_WIDTH - 8))
  const top = Math.max(8, Math.min(rect.top - 6, window.innerHeight - 220))

  const stop = async (jobs: Promise<Awaited<ReturnType<typeof api.proc.kill>>>[]): Promise<void> => {
    setBusy(true)
    setConfirm(false)
    setNote(outcome(await Promise.all(jobs)))
    setBusy(false)
  }
  const killLeftovers = (): Promise<void> =>
    stop(usage.sessions.filter((s) => s.leftovers.some((p) => p.owned)).map((s) => api.proc.kill(s.sessionId)))
  const killOne = (p: AttributedProc): Promise<void> => stop([api.proc.kill(p.sessionId, p.pid)])
  const names = [...new Set(leftovers.map((p) => p.label))]

  return createPortal(
    <div
      role="dialog"
      aria-label="Agent memory"
      className="bf-mem-pop"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        position: 'fixed',
        left,
        top,
        width: POPOVER_WIDTH,
        zIndex: 200,
        padding: '12px 12px 10px',
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        boxShadow: '0 1px 0 oklch(1 0 0 / 0.05) inset, 0 4px 12px rgba(0,0,0,0.25), 0 16px 40px rgba(0,0,0,0.45)',
        color: C.text,
        fontSize: 12
      }}
    >
      <div style={{ color: C.faint, marginBottom: 4, ...ELLIPSIS }}>{shortPath(usage.worktree)}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <strong style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', color: colorOf(usage.footprint, snapshot) }}>
          {approx(snapshot)}
          {formatBytes(usage.footprint)}
        </strong>
        <MemoryMeter bytes={usage.footprint} cpu={usage.cpu} snapshot={snapshot} />
      </div>
      <div style={{ display: 'flex', marginBottom: 10 }}>
        <UsageBar bytes={usage.footprint} snapshot={snapshot} />
      </div>

      {shown.map((p) => {
        const protectedRoot = p.isRoot && working.has(p.sessionId)
        const label = p.isRoot ? 'agent' : p.label
        const share = usage.footprint > 0 ? Math.min(100, (p.footprint / usage.footprint) * 100) : 0
        return (
          <div key={p.pid} className="bf-mem-row" style={row}>
            <span aria-hidden className="bf-mem-share" style={{ width: `${share}%` }} />
            <span
              aria-hidden
              style={{ width: 5, height: 5, borderRadius: '50%', flex: 'none', background: p.isRoot ? C.purpleSoft : C.fainter }}
            />
            <span style={{ flex: 1, minWidth: 0, ...ELLIPSIS }} title={label}>
              {label}
              {(ports[p.pid] ?? []).map((n) => (
                <span key={n} className="bf-mem-port">
                  :{n}
                </span>
              ))}
              {p.via === 'cwd' && !p.owned && <span style={{ color: C.faint }}> folder</span>}
            </span>
            <span style={{ color: C.textMuted }}>{formatBytes(p.footprint)}</span>
            <button
              type="button"
              className="bf-focus bf-icon-btn bf-mem-stop"
              disabled={busy || protectedRoot}
              title={protectedRoot ? 'The agent is working' : `Stop ${label}`}
              aria-label={`Stop ${label} ${p.pid}`}
              onClick={() => void killOne(p)}
              style={{ ...chipStyle, padding: 0, width: 16, justifyContent: 'center', cursor: 'pointer', color: C.faint, opacity: protectedRoot ? 0.3 : undefined }}
            >
              ×
            </button>
          </div>
        )
      })}
      {procs.length > shown.length && <div style={{ color: C.faint, padding: '3px 0 0 13px' }}>+{procs.length - shown.length} more</div>}

      {(!!leftovers.length || note || busy) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.hair}` }}>
          {busy || note ? (
            <span style={{ flex: 1, color: C.textSoft }}>{busy ? 'Stopping…' : note}</span>
          ) : confirm ? (
            <>
              <span style={{ flex: 1, minWidth: 0, ...ELLIPSIS }} title={names.join(', ')}>
                Stop {names.slice(0, 2).join(', ')}
                {names.length > 2 ? '…' : ''}?
              </span>
              <button type="button" className="bf-focus" onClick={() => setConfirm(false)} style={{ ...actionStyle(C.textMuted), border: 0, background: 'transparent' }}>
                No
              </button>
              <button type="button" className="bf-focus" onClick={() => void killLeftovers()} style={{ ...actionStyle(C.app), border: 0, background: C.yellow, fontWeight: 600 }}>
                Stop
              </button>
            </>
          ) : (
            <button type="button" className="bf-focus" onClick={() => setConfirm(true)} style={{ ...actionStyle(C.yellow), flex: 1, borderRadius: 8, padding: '6px 12px' }}>
              Stop leftovers
            </button>
          )}
        </div>
      )}
    </div>,
    document.body
  )
}

/** Listening ports by pid, read when the popover opens and when its set of processes changes. */
function useSessionPorts(usage: WorktreeUsage): Record<number, number[]> {
  const [ports, setPorts] = useState<Record<number, number[]>>({})
  const sessionKey = usage.sessions.map((s) => s.sessionId).join()
  const pidKey = usage.sessions.flatMap((s) => s.procs.map((p) => p.pid)).join()
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
  return ports
}

function actionStyle(color: string): React.CSSProperties {
  return {
    border: `1px solid color-mix(in oklch, ${color} 45%, transparent)`,
    background: `color-mix(in oklch, ${color} 14%, transparent)`,
    color,
    borderRadius: 999,
    padding: '4px 12px',
    fontSize: 11.5,
    cursor: 'pointer'
  }
}
