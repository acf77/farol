import { useEffect, useState } from 'react'
import { C, MONO, PANE } from '../theme'
import type { Tab, View } from '../types'
import { leaves } from '../layout'
import PaneGrid from './PaneGrid'
import { SplitDownIcon, SplitRightIcon } from './icons'

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
  onClosePane: (tabId: string, paneId: string) => void
  onResize: (tabId: string, nodeId: string, size: number) => void
  onSplitRight: () => void
  onSplitDown: () => void
  /** Whether the active tab can be split (shell with a focused shell pane). */
  canSplit: boolean
}

interface CtxMenu {
  x: number
  y: number
}

/**
 * The terminal surface. Unlike the old top-level tab strip, the tabs belong to
 * this pane — which is what lets chat sit beside it in `split` without two
 * competing tab bars.
 */
export default function TerminalPane({
  tabs,
  activeId,
  view: _view,
  workspaceVisible = true,
  branch,
  cwd,
  onSelect,
  onClose,
  onNew,
  onFocusPane,
  onClosePane,
  onResize,
  onSplitRight,
  onSplitDown,
  canSplit
}: Props) {
  const shellCount = tabs.filter((t) => t.kind === 'shell').length
  const [ctx, setCtx] = useState<CtxMenu | null>(null)

  useEffect(() => {
    if (!ctx) return
    const close = (): void => setCtx(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [ctx])

  const openCtx = (e: React.MouseEvent): void => {
    if (!canSplit) return
    e.preventDefault()
    e.stopPropagation()
    setCtx({ x: e.clientX, y: e.clientY })
  }

  const dotFor = (t: Tab): string =>
    t.status === 'running' ? C.accentBright : t.status === 'pass' ? C.green : t.status === 'fail' ? C.red : '#4b5567'

  const splitBtn = (label: string, title: string, onClick: () => void, Icon: typeof SplitRightIcon) => (
    <button
      type="button"
      className="bf-focus bf-split-btn"
      disabled={!canSplit}
      onClick={onClick}
      onContextMenu={openCtx}
      title={title}
      aria-label={label}
      style={{
        width: 24,
        height: 22,
        flex: 'none',
        padding: 0,
        border: 0,
        borderRadius: 5,
        background: 'transparent',
        color: canSplit ? '#8e8e93' : '#3a4356',
        display: 'grid',
        placeItems: 'center',
        cursor: canSplit ? 'pointer' : 'default'
      }}
    >
      <Icon size={14} />
    </button>
  )

  return (
    <div style={{ ...PANE, flex: 1, minHeight: 0, background: '#0b0f16' }}>
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
            const paneCount = leaves(t.root).length
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
                onContextMenu={(e) => {
                  onSelect(t.id)
                  openCtx(e)
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
                {paneCount > 1 && (
                  <span style={{ flex: 'none', fontFamily: MONO, fontSize: 9.5, color: '#6d7686' }}>
                    ×{paneCount}
                  </span>
                )}
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 'none' }}>
          {splitBtn('Split right', 'Split right (⌘D)', onSplitRight, SplitRightIcon)}
          {splitBtn('Split down', 'Split down (⇧⌘D)', onSplitDown, SplitDownIcon)}
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

      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: '#0b0f16' }}>
        {tabs.map((t) => {
          const shown = t.id === activeId
          return (
            <div
              key={t.id}
              aria-hidden={!shown}
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                transform: shown ? 'none' : 'translateX(-120%)',
                pointerEvents: shown ? 'auto' : 'none',
                zIndex: shown ? 1 : 0,
                background: '#0b0f16'
              }}
            >
              <PaneGrid
                tab={t}
                visible={shown && workspaceVisible}
                onFocusPane={(paneId) => onFocusPane(t.id, paneId)}
                onClosePane={(paneId) => onClosePane(t.id, paneId)}
                onResize={(nodeId, size) => onResize(t.id, nodeId, size)}
                onContextMenu={openCtx}
              />
            </div>
          )
        })}
      </div>

      {ctx && canSplit && (
        <div
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: Math.min(ctx.x, window.innerWidth - 200),
            top: Math.min(ctx.y, window.innerHeight - 100),
            zIndex: 80,
            minWidth: 180,
            background: '#2c2c2e',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8,
            boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
            padding: 5
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="bf-focus bf-menu-item"
            onClick={() => {
              onSplitRight()
              setCtx(null)
            }}
            style={{
              display: 'flex',
              width: '100%',
              alignItems: 'center',
              gap: 8,
              border: 'none',
              background: 'transparent',
              color: '#e8e8ea',
              cursor: 'pointer',
              textAlign: 'left'
            }}
          >
            <SplitRightIcon size={13} />
            <span style={{ flex: 1 }}>Split right</span>
            <span style={{ fontSize: 11, color: '#8e8e93' }}>⌘D</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="bf-focus bf-menu-item"
            onClick={() => {
              onSplitDown()
              setCtx(null)
            }}
            style={{
              display: 'flex',
              width: '100%',
              alignItems: 'center',
              gap: 8,
              border: 'none',
              background: 'transparent',
              color: '#e8e8ea',
              cursor: 'pointer',
              textAlign: 'left'
            }}
          >
            <SplitDownIcon size={13} />
            <span style={{ flex: 1 }}>Split down</span>
            <span style={{ fontSize: 11, color: '#8e8e93' }}>⇧⌘D</span>
          </button>
        </div>
      )}
    </div>
  )
}
