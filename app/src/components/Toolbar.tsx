import { useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import { C } from '../theme'
import type { View } from '../types'
import { SURFACES, SURFACE_LABEL, type Surface } from '../workspace-layout'
import { REMOTE_ENABLED } from '@shared/features'
import AccountMenu from './AccountMenu'
import { CHROME_ROW } from './side-panel'
import ActivityDot from './ActivityDot'
import { SettingsIcon } from './icons'

interface Props {
  project: Project | null
  /** The preset the layout matches; null once the panels are split some other way. */
  view: View | null
  onView: (v: View) => void
  /** Surface that Split and Close act on, and the surfaces currently on screen. */
  focus: Surface
  surfaces: Surface[]
  onSplit: (dir: 'row' | 'col', surface: Surface) => void
  onCloseSurface: (surface: Surface) => void
  /** A terminal tab has a running server, run or agent session. */
  terminalBusy?: boolean
  /** The agent is working, or has asked a question and is waiting for an answer. */
  chatState?: 'asking' | 'busy' | null
  /** Set when a newer build is in the local update feed. */
  updateVersion: string | null
  onInstallUpdate: () => void
  onOpenSettings: () => void
}

const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

const SOFT = 'oklch(1 0 0 / 0.06)'

const menuItem: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  border: 'none',
  background: 'transparent',
  color: C.text
}

const VIEWS: { key: View; label: string; shortcut: string }[] = [
  { key: 'chat', label: 'Chat', shortcut: '⌘1' },
  { key: 'code', label: 'Code', shortcut: '⌘2' },
  { key: 'terminal', label: 'Terminal', shortcut: '⌘3' },
  { key: 'split', label: 'Split', shortcut: '⌘4' }
]

/** The two-pane glyph the design uses on the Split segment and the split menu trigger. */
function SplitGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M8 2.5v11" />
    </svg>
  )
}

const DIRECTIONS = [
  { dir: 'row', label: 'right' },
  { dir: 'col', label: 'down' }
] as const

/** Splits the focused surface with any other; a surface already on screen moves beside it. */
function SplitMenu({
  focus,
  surfaces,
  onSplit,
  onCloseSurface,
  onClose
}: {
  focus: Surface
  surfaces: Surface[]
  onSplit: (dir: 'row' | 'col', surface: Surface) => void
  onCloseSurface: (surface: Surface) => void
  onClose: () => void
}) {
  const run = (action: () => void) => () => {
    onClose()
    action()
  }
  return (
    <>
      <div aria-hidden onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
      <div
        role="menu"
        aria-label="Split panel"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        style={{
          ...noDrag,
          position: 'absolute',
          top: 34,
          right: 0,
          zIndex: 50,
          width: 210,
          background: 'oklch(0.26 0.006 95)',
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          boxShadow: '0 12px 32px rgba(0,0,0,.45)',
          padding: 4
        }}
      >
        {DIRECTIONS.map(({ dir, label }) => (
          <div key={dir} role="group" aria-label={`Split ${SURFACE_LABEL[focus]} ${label}`}>
            <div style={{ padding: '6px 9px 4px', fontSize: 11, color: C.faint }}>
              Split {SURFACE_LABEL[focus]} {label} with
            </div>
            {SURFACES.filter((s) => s !== focus).map((s) => (
              <button
                key={s}
                type="button"
                role="menuitem"
                className="bf-focus bf-menu-item"
                onClick={run(() => onSplit(dir, s))}
                style={{ ...menuItem, display: 'flex', justifyContent: 'space-between' }}
              >
                <span>{SURFACE_LABEL[s]}</span>
                {surfaces.includes(s) && <span style={{ fontSize: 10.5, color: C.faint }}>moves here</span>}
              </button>
            ))}
          </div>
        ))}
        {surfaces.length > 1 && (
          <>
            <div role="separator" style={{ height: 1, background: C.border, margin: '5px 6px' }} />
            <button
              type="button"
              role="menuitem"
              className="bf-focus bf-menu-item"
              onClick={run(() => onCloseSurface(focus))}
              style={menuItem}
            >
              Close {SURFACE_LABEL[focus]} panel
            </button>
          </>
        )}
      </div>
    </>
  )
}

export default function Toolbar({
  project,
  view,
  onView,
  focus,
  surfaces,
  onSplit,
  onCloseSurface,
  terminalBusy,
  chatState,
  updateVersion,
  onInstallUpdate,
  onOpenSettings
}: Props) {
  const [splitOpen, setSplitOpen] = useState(false)

  /** ⌘1–⌘4 jump between the views, as the segment tooltips promise. */
  useEffect(() => {
    if (!project) return
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      const view = VIEWS[Number(e.key) - 1]
      if (!view) return
      e.preventDefault()
      onView(view.key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [project, onView])

  const iconButton: React.CSSProperties = {
    ...noDrag,
    width: 28,
    height: 28,
    borderRadius: 7,
    border: 'none',
    background: 'transparent',
    color: C.textRow,
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer'
  }

  return (
    // The bar is fixed so it spans the whole window, over the Projects rail; this
    // spacer keeps the workspace below it.
    <div style={{ height: CHROME_ROW, flex: 'none' }}>
    <div
      style={{
        ...drag,
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: CHROME_ROW,
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
        alignItems: 'center',
        padding: '0 12px 0 18px',
        columnGap: 18,
        zIndex: 30,
        borderBottom: `1px solid ${C.hair}`,
        background: C.app
      }}
    >
      <div style={{ gridColumn: 1, gridRow: 1, minWidth: 0 }} />

      <div style={{ ...noDrag, display: 'flex', alignItems: 'center', gap: 6, gridColumn: 2, gridRow: 1, justifySelf: 'center', position: 'relative' }}>
        <div
          role="radiogroup"
          aria-label="View"
          style={{ display: 'flex', padding: 2, borderRadius: 9, background: 'oklch(0.21 0.005 95)', border: `1px solid ${SOFT}` }}
        >
          {VIEWS.map((v) => {
            const on = view === v.key
            return (
              <div
                key={v.key}
                role="radio"
                aria-checked={on}
                tabIndex={0}
                className="bf-focus"
                onClick={() => {
                  setSplitOpen(false)
                  onView(v.key)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onView(v.key)
                  }
                }}
                title={`${v.label} (${v.shortcut})`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 14px',
                  borderRadius: 7,
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: 'pointer',
                  background: on ? 'oklch(0.31 0.006 95)' : 'transparent',
                  color: on ? C.text : C.textMuted,
                  boxShadow: on ? '0 1px 2px rgba(0,0,0,.25)' : 'none'
                }}
              >
                {v.key === 'split' && <SplitGlyph size={12} />}
                <span>{v.label}</span>
                {v.key === 'chat' && chatState === 'busy' && <ActivityDot active title="Agent working" />}
                {v.key === 'chat' && chatState === 'asking' && (
                  <span
                    role="status"
                    title="Waiting for your answer"
                    aria-label="Waiting for your answer"
                    style={{ width: 7, height: 7, flex: 'none', borderRadius: '50%', background: C.yellow, animation: 'bfpulse 1.1s ease-in-out infinite' }}
                  />
                )}
                {v.key === 'terminal' && terminalBusy && <ActivityDot active title="Terminal activity in progress" />}
              </div>
            )
          })}
        </div>
        {project && (
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="bf-focus bf-icon-btn"
              onClick={() => setSplitOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={splitOpen}
              aria-label="Configure split"
              title="Configure split"
              style={iconButton}
            >
              <SplitGlyph size={14} />
            </button>
            {splitOpen && (
              <SplitMenu
                focus={focus}
                surfaces={surfaces}
                onSplit={onSplit}
                onCloseSurface={onCloseSurface}
                onClose={() => setSplitOpen(false)}
              />
            )}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 6,
          gridColumn: 3,
          gridRow: 1,
          position: 'relative',
          zIndex: 2
        }}
      >
        {updateVersion && (
          <button
            type="button"
            className="bf-focus bf-btn-primary"
            onClick={onInstallUpdate}
            title={`Install Farol ${updateVersion} and restart`}
            style={{
              ...noDrag,
              height: 24,
              padding: '0 10px',
              borderRadius: 7,
              border: 'none',
              background: C.accent,
              color: C.accentInk,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            Update
          </button>
        )}

        <button
          type="button"
          className="bf-focus bf-icon-btn"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
          style={iconButton}
        >
          <SettingsIcon size={14} />
        </button>

        {REMOTE_ENABLED && <AccountMenu />}
      </div>

    </div>
    </div>
  )
}
