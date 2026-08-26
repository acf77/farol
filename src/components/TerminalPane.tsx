import { C, MONO, PANE } from '../theme'
import type { Tab, View } from '../types'
import XtermPane from './XtermPane'
import LogPane from './LogPane'

interface Props {
  tabs: Tab[]
  activeId: string
  view: View
  workspaceVisible?: boolean
  /** Branch of the active checkout — run tabs from another branch are marked. */
  branch: string
  /** Home-relative cwd of the focused pane, shown at the strip's right edge. */
  cwd: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onFocusPane: (tabId: string, paneId: string) => void
}

/**
 * The terminal surface. Unlike the old top-level tab strip, the tabs belong to
 * this pane — which is what lets chat sit beside it in `split` without two
 * competing tab bars.
 */
export default function TerminalPane({
  tabs,
  activeId,
  view,
  workspaceVisible = true,
  branch,
  cwd,
  onSelect,
  onClose,
  onNew,
  onFocusPane
}: Props) {
  const shellCount = tabs.filter((t) => t.kind === 'shell').length

  const dotFor = (t: Tab): string =>
    t.status === 'running' ? C.accentBright : t.status === 'pass' ? C.green : t.status === 'fail' ? C.red : '#4b5567'

  return (
    <div style={{ ...PANE, flex: view === 'split' ? '1 1 50%' : '1 1 100%', background: '#0b0f16' }}>
      <div
        style={{
          flex: 'none',
          height: 36,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 8px 0 0',
          borderBottom: '1px solid #1c2230'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'stretch', height: '100%', minWidth: 0, overflow: 'hidden' }}>
          {tabs.map((t) => {
            const on = t.id === activeId
            const canClose = !(t.kind === 'shell' && shellCount <= 1)
            return (
              <div
                key={t.id}
                className={`bf-term-tab${on ? ' bf-term-tab-active' : ''}`}
                role="tab"
                aria-selected={on}
                tabIndex={0}
                onClick={() => onSelect(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(t.id)
                  }
                }}
                onAuxClick={(e) => {
                  if (e.button === 1 && canClose) onClose(t.id)
                }}
                title={t.branch && t.branch !== branch ? `${t.title} — on ${t.branch}` : t.title}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  height: '100%',
                  padding: '0 12px',
                  borderRadius: 0,
                  borderBottom: on ? '1px solid #0b0f16' : '1px solid transparent',
                  marginBottom: -1,
                  fontSize: 12,
                  cursor: 'pointer',
                  minWidth: 0,
                  flex: 'none',
                  maxWidth: 200,
                  background: on ? '#0b0f16' : 'transparent',
                  color: on ? '#eef1f6' : '#8b94a3',
                  outline: 'none'
                }}
              >
                <div
                  style={{
                    width: 7,
                    height: 7,
                    flex: 'none',
                    borderRadius: '50%',
                    background: dotFor(t),
                    animation: t.status === 'running' ? 'bfpulse 1.1s ease-in-out infinite' : 'none'
                  }}
                />
                <span
                  style={{
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    minWidth: 0
                  }}
                >
                  {t.title}
                </span>
                {/* Amber once the checkout has moved on from the run's branch. */}
                {t.kind === 'run' && t.branch && t.branch !== branch && (
                  <span style={{ flex: 'none', fontFamily: MONO, fontSize: 9.5, color: C.yellowDim }}>
                    ⑂
                  </span>
                )}
                {canClose && (
                  <span
                    className="bf-tab-close"
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose(t.id)
                    }}
                    title="Close tab (⌘W)"
                    style={{
                      flex: 'none',
                      width: 14,
                      height: 14,
                      borderRadius: 4,
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 11,
                      color: 'rgba(255,255,255,0.35)',
                      cursor: 'pointer'
                    }}
                  >
                    ×
                  </span>
                )}
              </div>
            )
          })}
        </div>

        <div
          className="bf-icon-btn"
          onClick={onNew}
          title="New terminal tab (⌘T)"
          style={{
            width: 24,
            height: 24,
            flex: 'none',
            borderRadius: 7,
            display: 'grid',
            placeItems: 'center',
            color: '#8b94a3',
            fontSize: 15,
            cursor: 'pointer'
          }}
        >
          +
        </div>

        <span style={{ flex: 1 }} />
        <span
          title={cwd}
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: '#6d7686',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '45%'
          }}
        >
          {cwd}
        </span>
      </div>

      {/*
        Every tab stays mounted: a shell pane owns a live PTY and xterm buffer,
        so unmounting a hidden tab would drop the scrollback and resize the
        shell to nothing. Visibility switches instead.
      */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: '#0b0f16' }}>
        {tabs.map((t) => {
          const shown = t.id === activeId
          const pane = t.panes[t.focus]
          if (!pane) return null
          return (
            <div
              key={t.id}
              aria-hidden={!shown}
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                // Park inactive tabs off-screen with full size so xterm keeps
                // a real measure and its canvas cannot paint through the active tab.
                transform: shown ? 'none' : 'translateX(-120%)',
                pointerEvents: shown ? 'auto' : 'none',
                zIndex: shown ? 1 : 0,
                background: '#0b0f16'
              }}
            >
              {pane.kind === 'shell' ? (
                <XtermPane
                  paneId={pane.id}
                  cwd={pane.cwd}
                  visible={shown && workspaceVisible}
                  focused={shown && workspaceVisible}
                  onFocus={() => onFocusPane(t.id, pane.id)}
                />
              ) : pane.kind === 'run' ? (
                <LogPane term={pane.term} />
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
