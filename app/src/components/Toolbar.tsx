import { useEffect, useState } from 'react'
import type { AppSettings, Project } from '@shared/types'
import { C, MONO, glass as G } from '../theme'
import type { View } from '../types'
import { SURFACES, SURFACE_LABEL, type Surface } from '../workspace-layout'
import AccountMenu from './AccountMenu'
import { Checkbox } from './controls'
import { CHROME_ROW } from './side-panel'
import { FolderPlusIcon, SettingsIcon } from './icons'

interface Props {
  liquid?: boolean
  project: Project | null
  /** The preset the layout matches; null once the panels are split some other way. */
  view: View | null
  onView: (v: View) => void
  /** Surface that Split and Close act on, and the surfaces currently on screen. */
  focus: Surface
  surfaces: Surface[]
  onSplit: (dir: 'row' | 'col', surface: Surface) => void
  onCloseSurface: (surface: Surface) => void
  /** New shell tab in the active project (always available). */
  onNewTerminal: () => void
  recents: Project[]
  menuOpen: boolean
  menuDisabled: boolean
  onMenuToggle: () => void
  onMenuClose: () => void
  onOpenProject: () => void
  onOpenRecent: (path: string) => void
  onCloseProject: () => void
  /** Set when a newer build is in the local update feed. */
  updateVersion: string | null
  onInstallUpdate: () => void
  settings: AppSettings
  onSettings: (next: AppSettings) => void
  onOpenSettings: () => void
}

const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

const TRIGGER_ID = 'bf-project-menu-trigger'

const menuItem: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  border: 'none',
  background: 'transparent',
  color: C.text
}

const VIEWS: { key: View; label: string }[] = [
  { key: 'chat', label: 'Chat' },
  { key: 'code', label: 'Code' },
  { key: 'terminal', label: 'Terminal' },
  { key: 'split', label: 'Split 50/50' }
]

const DIRECTIONS = [
  { dir: 'row', label: 'right' },
  { dir: 'col', label: 'down' }
] as const

/** Splits the focused surface with any other; a surface already on screen moves beside it. */
function SplitMenu({
  liquid,
  focus,
  surfaces,
  onSplit,
  onCloseSurface,
  onClose
}: {
  liquid?: boolean
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
          top: CHROME_ROW,
          left: 16,
          zIndex: 50,
          width: 220,
          background: liquid ? G.panel : C.sidebar,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          boxShadow: '0 18px 44px rgba(0,0,0,0.55)',
          padding: 5
        }}
      >
        {DIRECTIONS.map(({ dir, label }) => (
          <div key={dir} role="group" aria-label={`Split ${SURFACE_LABEL[focus]} ${label}`}>
            <div style={{ padding: '6px 10px 2px', fontSize: 10.5, color: C.faint }}>
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
  liquid,
  project,
  view,
  onView,
  focus,
  surfaces,
  onSplit,
  onCloseSurface,
  onNewTerminal,
  recents,
  menuOpen,
  menuDisabled,
  onMenuToggle,
  onMenuClose,
  onOpenProject,
  onOpenRecent,
  onCloseProject,
  updateVersion,
  onInstallUpdate,
  settings,
  onSettings,
  onOpenSettings
}: Props) {
  const [splitOpen, setSplitOpen] = useState(false)

  /** Escape dismisses the file menu and returns focus to its trigger. */
  useEffect(() => {
    if (!menuOpen) return
    if (menuDisabled) {
      onMenuClose()
      return
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      onMenuClose()
      document.getElementById(TRIGGER_ID)?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menuOpen, menuDisabled, onMenuClose])

  return (
    <div
      style={{
        ...drag,
        height: CHROME_ROW,
        flex: 'none',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
        gridTemplateRows: `${CHROME_ROW}px`,
        alignItems: 'center',
        padding: '0 16px',
        columnGap: 18,
        position: 'relative',
        zIndex: 30,
        background: liquid ? G.appBg : C.terminal
      }}
    >
      <div
        role="radiogroup"
        aria-label="View"
        style={{
          ...noDrag,
          display: 'flex',
          gap: 2,
          gridColumn: 2,
          gridRow: 1,
          justifySelf: 'center'
        }}
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
              onClick={() => onView(v.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onView(v.key)
                }
              }}
              title={`${v.label} view`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '6px 12px',
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                background: on ? C.sidebar : 'transparent',
                color: on ? C.text : C.textMuted
              }}
            >
              {v.label}
            </div>
          )
        })}
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-start',
          gap: 8,
          minWidth: 0,
          gridColumn: 1,
          gridRow: 1
        }}
      >
        {project && (
          <button
            type="button"
            className="bf-focus"
            onClick={onNewTerminal}
            title="New terminal tab (⌘T)"
            style={{
              ...noDrag,
              height: 28,
              padding: '0 10px',
              borderRadius: 6,
              border: '1px solid #3E3E3A',
              background: C.panel,
              color: C.text,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            New terminal
          </button>
        )}
        {project && (
          <button
            type="button"
            className="bf-focus"
            onClick={() => setSplitOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={splitOpen}
            title="Split the focused panel"
            style={{
              ...noDrag,
              height: 28,
              padding: '0 10px',
              borderRadius: 6,
              border: '1px solid #3E3E3A',
              background: C.panel,
              color: C.text,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            Split
          </button>
        )}
        <button
          type="button"
          className="bf-focus bf-icon-btn"
          onClick={onOpenProject}
          title="Open repository…"
          aria-label="Open repository"
          style={{
            ...noDrag,
            width: 28,
            height: 28,
            borderRadius: 6,
            border: `1px solid ${C.border}`,
            background: C.sidebar,
            color: C.text,
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer'
          }}
        >
          <FolderPlusIcon size={14} />
        </button>
      </div>

      {splitOpen && (
        <SplitMenu
          liquid={liquid}
          focus={focus}
          surfaces={surfaces}
          onSplit={onSplit}
          onCloseSurface={onCloseSurface}
          onClose={() => setSplitOpen(false)}
        />
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          gridColumn: 3,
          gridRow: 1,
          justifySelf: 'end',
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
              borderRadius: 8,
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
          style={{
            ...noDrag,
            width: 28,
            height: 28,
            borderRadius: 6,
            border: `1px solid ${C.border}`,
            background: C.sidebar,
            color: C.text,
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer'
          }}
        >
          <SettingsIcon size={14} />
        </button>

        <button
          id={TRIGGER_ID}
          type="button"
          className="bf-focus"
          disabled={menuDisabled}
          onClick={onMenuToggle}
          aria-haspopup="menu"
          aria-expanded={menuOpen && !menuDisabled}
          title={menuDisabled ? 'Close Settings or the pipeline editor to use File' : 'Project menu'}
          style={{
            ...noDrag,
            border: 'none',
            background: 'transparent',
            fontSize: 12,
            color: C.textMuted,
            cursor: menuDisabled ? 'default' : 'pointer',
            opacity: menuDisabled ? 0.5 : 1,
            padding: '4px 6px'
          }}
        >
          File
        </button>

        <AccountMenu liquid={liquid} />
      </div>

      {menuOpen && !menuDisabled && (
        <div
          aria-hidden
          onClick={onMenuClose}
          style={{ position: 'fixed', inset: 0, zIndex: 40 }}
        />
      )}

      {menuOpen && !menuDisabled && (
        <div
          role="menu"
          aria-label="Project"
          style={{
            ...noDrag,
            position: 'absolute',
            top: CHROME_ROW,
            right: 16,
            zIndex: 50,
            width: 292,
            background: liquid ? G.panel : C.sidebar,
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            boxShadow: '0 18px 44px rgba(0,0,0,0.55)',
            padding: 5
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="bf-focus bf-menu-item"
            onClick={onOpenProject}
            style={menuItem}
          >
            Open Project…
          </button>
          {recents.slice(0, 5).map((r) => (
            <button
              key={r.path}
              type="button"
              role="menuitem"
              className="bf-focus bf-menu-item"
              onClick={() => onOpenRecent(r.path)}
              style={{ ...menuItem, display: 'flex', justifyContent: 'space-between', gap: 8 }}
            >
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                Recent · {r.name}
              </span>
              <span
                style={{
                  opacity: 0.5,
                  fontFamily: MONO,
                  fontSize: 10,
                  flex: 'none',
                  maxWidth: 96,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {r.display.replace(`/${r.name}`, '') || '~'}
              </span>
            </button>
          ))}
          {project && (
            <>
              <div role="separator" style={{ height: 1, background: C.border, margin: '5px 6px' }} />
              <button
                type="button"
                role="menuitem"
                className="bf-focus bf-menu-item"
                onClick={onCloseProject}
                style={menuItem}
              >
                Close Project
              </button>
            </>
          )}
          <div role="separator" style={{ height: 1, background: C.border, margin: '5px 6px' }} />
          <button
            type="button"
            role="menuitem"
            className="bf-focus bf-menu-item"
            onClick={() => {
              onMenuClose()
              onOpenSettings()
            }}
            style={menuItem}
          >
            Settings…
          </button>
          <div role="separator" style={{ height: 1, background: C.border, margin: '5px 6px' }} />
          <div style={{ padding: '6px 10px 8px' }}>
            <Checkbox
              checked={settings.autoFix}
              onChange={(autoFix) => onSettings({ ...settings, autoFix })}
              title="On a failed step, send the failure report to Chat"
              style={{ fontSize: 11, color: C.textMuted }}
            >
              Send failures to the agent
            </Checkbox>
          </div>
        </div>
      )}
    </div>
  )
}
