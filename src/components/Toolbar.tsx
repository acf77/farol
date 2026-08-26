import { useEffect } from 'react'
import type { AppSettings, Project } from '@shared/types'
import { C, MONO, glass as G } from '../theme'
import type { View } from '../types'
import { Checkbox } from './controls'
import {
  BellIcon,
  ChatIcon,
  FolderPlusIcon,
  GearIcon,
  SearchIcon,
  SplitIcon,
  TerminalIcon
} from './icons'

interface Props {
  liquid?: boolean
  project: Project | null
  view: View
  onView: (v: View) => void
  /** New shell tab in the active project (always available). */
  onNewTerminal: () => void
  recents: Project[]
  menuOpen: boolean
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
  settingsOpen: boolean
  onSettingsToggle: () => void
  onSettingsClose: () => void
  onSearch: () => void
  /** Hide traffic lights when the project rail owns them. */
  showTrafficLights?: boolean
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

const VIEWS: { key: View; label: string; Icon: (p: { size?: number }) => JSX.Element }[] = [
  { key: 'chat', label: 'Chat', Icon: ChatIcon },
  { key: 'terminal', label: 'Terminal', Icon: TerminalIcon },
  { key: 'split', label: 'Split 50/50', Icon: SplitIcon }
]

function Light({ color, title, onClick }: { color: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="bf-focus"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        ...noDrag,
        width: 12,
        height: 12,
        borderRadius: '50%',
        border: 'none',
        padding: 0,
        background: color,
        cursor: 'pointer'
      }}
    />
  )
}

export default function Toolbar({
  liquid,
  project,
  view,
  onView,
  onNewTerminal,
  recents,
  menuOpen,
  onMenuToggle,
  onMenuClose,
  onOpenProject,
  onOpenRecent,
  onCloseProject,
  updateVersion,
  onInstallUpdate,
  settings,
  onSettings,
  settingsOpen,
  onSettingsToggle,
  onSettingsClose,
  onSearch,
  showTrafficLights = false
}: Props) {
  const api = window.buildflow

  /** Escape dismisses whichever popover is open and returns focus to its trigger. */
  useEffect(() => {
    if (!menuOpen && !settingsOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (menuOpen) {
        onMenuClose()
        document.getElementById(TRIGGER_ID)?.focus()
      }
      if (settingsOpen) onSettingsClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menuOpen, settingsOpen, onMenuClose, onSettingsClose])

  return (
    <div
      style={{
        ...drag,
        height: 52,
        flex: 'none',
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr) auto',
        gridTemplateRows: '52px',
        alignItems: 'center',
        padding: '0 16px',
        columnGap: 18,
        position: 'relative',
        zIndex: 30,
        background: liquid ? G.chrome : 'transparent'
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', gridColumn: 1, gridRow: 1 }}>
        {showTrafficLights && (
          <>
            <Light color={C.light.red} title="Close" onClick={() => api.window.close()} />
            <Light color={C.light.yellow} title="Minimise" onClick={() => api.window.minimize()} />
            <Light color={C.light.green} title="Zoom" onClick={() => api.window.maximize()} />
          </>
        )}
      </div>

      <div
        role="radiogroup"
        aria-label="View"
        style={{
          ...noDrag,
          display: 'flex',
          gap: 2,
          padding: 3,
          background: '#12171f',
          border: '1px solid #232a37',
          borderRadius: 8,
          gridColumn: 2,
          gridRow: 1,
          justifySelf: 'center',
          zIndex: 1
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
                fontSize: 12.5,
                fontWeight: 500,
                cursor: 'pointer',
                background: on ? '#212a39' : 'transparent',
                color: on ? '#eef1f6' : '#8b94a3'
              }}
            >
              <v.Icon />
              <span>{v.label}</span>
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
          gridColumn: 2,
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
              borderRadius: 7,
              border: '1px solid #283040',
              background: '#1b2230',
              color: '#dbe1ea',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <TerminalIcon size={12} />
            <span>New terminal</span>
          </button>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          gridColumn: 3,
          gridRow: 1,
          position: 'relative',
          zIndex: 2
        }}
      >
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
            borderRadius: 7,
            border: `1px solid ${C.border}`,
            background: C.card,
            color: C.text,
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer'
          }}
        >
          <FolderPlusIcon size={14} />
        </button>

        <div
          className="bf-focus"
          role="button"
          tabIndex={0}
          onClick={onSearch}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onSearch()
            }
          }}
          title="Search (⌘K)"
          style={{
            ...noDrag,
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '6px 9px',
            background: '#131822',
            border: '1px solid #242b39',
            borderRadius: 9,
            color: '#77808f',
            cursor: 'pointer'
          }}
        >
          <SearchIcon />
          <span style={{ fontSize: 12 }}>⌘K</span>
        </div>

        {updateVersion && (
          <span
            className="bf-focus"
            role="button"
            tabIndex={0}
            onClick={onInstallUpdate}
            title={`Install BuildFlow ${updateVersion} and restart`}
            style={{ ...noDrag, position: 'relative', display: 'grid', placeItems: 'center', cursor: 'pointer' }}
          >
            <BellIcon />
            <span
              style={{
                position: 'absolute',
                top: -1,
                right: -1,
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: C.accent
              }}
            />
          </span>
        )}

        <span
          id={TRIGGER_ID}
          className="bf-focus"
          role="button"
          tabIndex={0}
          onClick={onMenuToggle}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onMenuToggle()
            }
          }}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Project menu"
          style={{
            ...noDrag,
            fontSize: 12,
            color: C.textMuted,
            cursor: 'pointer',
            padding: '4px 6px'
          }}
        >
          File
        </span>

        <span
          className="bf-focus"
          role="button"
          tabIndex={0}
          onClick={onSettingsToggle}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onSettingsToggle()
            }
          }}
          aria-haspopup="menu"
          aria-expanded={settingsOpen}
          title="Settings"
          style={{ ...noDrag, display: 'grid', placeItems: 'center', cursor: 'pointer' }}
        >
          <GearIcon />
        </span>
      </div>

      {(menuOpen || settingsOpen) && (
        <div
          aria-hidden
          onClick={() => {
            onMenuClose()
            onSettingsClose()
          }}
          style={{ position: 'fixed', inset: 0, zIndex: 40 }}
        />
      )}

      {menuOpen && (
        <div
          role="menu"
          aria-label="Project"
          style={{
            ...noDrag,
            position: 'absolute',
            top: 52,
            right: 52,
            zIndex: 50,
            width: 260,
            background: liquid ? G.panel : '#111621',
            border: `1px solid ${C.cardBorder}`,
            borderRadius: 11,
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
        </div>
      )}

      {settingsOpen && (
        <div
          role="menu"
          aria-label="Settings"
          style={{
            ...noDrag,
            position: 'absolute',
            top: 52,
            right: 16,
            zIndex: 50,
            width: 252,
            background: liquid ? G.panel : '#111621',
            border: `1px solid ${C.cardBorder}`,
            borderRadius: 11,
            boxShadow: '0 18px 44px rgba(0,0,0,0.55)',
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 12
          }}
        >
          <Checkbox
            checked={settings.autoFix}
            onChange={(autoFix) => onSettings({ ...settings, autoFix })}
            title="On a failed step, open the agent in a terminal with the failure report"
            style={{ fontSize: 11.5, color: C.textMuted }}
          >
            Send failures to the agent
          </Checkbox>
          <div style={{ fontSize: 11, color: C.faint, lineHeight: 1.45 }}>
            Appearance follows the system window chrome. Pick the coding agent from the status bar or chat composer.
          </div>
        </div>
      )}
    </div>
  )
}
