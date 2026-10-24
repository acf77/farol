import { useEffect, useId, useRef, useState } from 'react'
import { C, MONO, PANE } from '../theme'
import type { Tab } from '../types'
import { leaves } from '../layout'
import PaneGrid from './PaneGrid'
import { SplitDownIcon, SplitRightIcon } from './icons'
import ActivityDot from './ActivityDot'

interface Props {
  tabs: Tab[]
  activeId: string
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
  /** The selected run or one of its shell panes currently has foreground work. */
  busy: boolean
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
  canSplit,
  busy
}: Props) {
  const shellCount = tabs.filter((t) => t.kind === 'shell').length
  const [ctx, setCtx] = useState<CtxMenu | null>(null)
  const tabPrefix = useId()
  const tabRefs = useRef(new Map<string, HTMLDivElement>())

  const closeTab = (id: string): void => {
    const tab = tabRefs.current.get(id)
    if (tab?.contains(document.activeElement)) {
      const index = tabs.findIndex((t) => t.id === id)
      const next = tabs[index + 1] ?? tabs[index - 1]
      if (next) tabRefs.current.get(next.id)?.focus()
    }
    onClose(id)
  }

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
    t.status === 'running' ? C.accent : t.status === 'pass' ? C.green : t.status === 'fail' ? C.red : C.faint

  const statusWord = (t: Tab): string =>
    t.status === 'running' ? 'running' : t.status === 'pass' ? 'passed' : t.status === 'fail' ? 'failed' : ''

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
        borderRadius: 4,
        background: 'transparent',
        color: canSplit ? C.textMuted : C.faint,
        display: 'grid',
        placeItems: 'center',
        cursor: canSplit ? 'pointer' : 'default'
      }}
    >
      <Icon size={14} />
    </button>
  )

  return (
    <div style={{ ...PANE, flex: 1, minHeight: 0, background: C.app }}>
      <div
        style={{
          flex: 'none',
          height: 36,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 8px 0 0',
          borderBottom: '1px solid #3E3E3A'
        }}
      >
        <div
          role="tablist"
          aria-label="Terminal tabs"
          style={{
            display: 'flex',
            alignItems: 'stretch',
            height: '100%',
            minWidth: 0,
            overflowX: 'auto',
            overflowY: 'hidden'
          }}
        >
          {tabs.map((t) => {
            const on = t.id === activeId
            const canClose = !(t.kind === 'shell' && shellCount <= 1)
            const paneCount = leaves(t.root).length
            const status = statusWord(t)
            return (
              <div
                key={t.id}
                className={`bf-term-tab${on ? ' bf-term-tab-active' : ''}`}
                ref={(element) => {
                  if (element) tabRefs.current.set(t.id, element)
                  else tabRefs.current.delete(t.id)
                }}
                id={`${tabPrefix}-tab-${t.id}`}
                role="tab"
                aria-controls={`${tabPrefix}-panel-${t.id}`}
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                onClick={() => onSelect(t.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(t.id)
                  } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                    e.preventDefault()
                    const index = tabs.indexOf(t)
                    const nextIndex = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
                      : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
                    const next = tabs[nextIndex]
                    onSelect(next.id)
                    tabRefs.current.get(next.id)?.focus()
                  } else if (e.key === 'Delete' && canClose) {
                    e.preventDefault()
                    closeTab(t.id)
                  }
                }}
                onAuxClick={(e) => {
                  if (e.button === 1 && canClose) closeTab(t.id)
                }}
                onContextMenu={(e) => {
                  onSelect(t.id)
                  openCtx(e)
                }}
                title={t.branch && t.branch !== branch ? `${t.title} (on ${t.branch})` : t.title}
                aria-label={`${t.title}${t.branch && t.branch !== branch ? ` (on ${t.branch})` : ''}${status ? `, ${status}` : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  height: '100%',
                  padding: '0 12px',
                  borderRadius: 0,
                  borderBottom: on ? '1px solid #181817' : '1px solid transparent',
                  marginBottom: -1,
                  fontSize: 12,
                  cursor: 'pointer',
                  minWidth: 0,
                  flex: 'none',
                  maxWidth: 200,
                  background: on ? C.app : 'transparent',
                  color: on ? C.text : C.textMuted,
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
                  <span style={{ flex: 'none', fontFamily: MONO, fontSize: 10, color: C.faint }}>
                    ×{paneCount}
                  </span>
                )}
                {t.kind === 'run' && t.branch && t.branch !== branch && (
                  <span style={{ flex: 'none', fontFamily: MONO, fontSize: 10, color: C.yellowDim }}>
                    ⑂
                  </span>
                )}
                {canClose && (
                  <button
                    type="button"
                    className="bf-tab-close bf-focus"
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(t.id)
                    }}
                    title="Close tab (⌘W)"
                    aria-label={`Close ${t.title}`}
                    style={{
                      flex: 'none',
                      width: 14,
                      height: 14,
                      padding: 0,
                      border: 'none',
                      borderRadius: 4,
                      background: 'transparent',
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 11,
                      color: 'rgba(255,255,255,0.35)',
                      cursor: 'pointer'
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <button
          type="button"
          className="bf-focus bf-icon-btn"
          onClick={onNew}
          title="New terminal tab (⌘T)"
          aria-label="New terminal tab"
          style={{
            width: 24,
            height: 24,
            flex: 'none',
            padding: 0,
            border: 'none',
            background: 'transparent',
            borderRadius: 8,
            display: 'grid',
            placeItems: 'center',
            color: C.textMuted,
            fontSize: 16,
            cursor: 'pointer'
          }}
        >
          +
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 'none' }}>
          {splitBtn('Split right', 'Split right (⌘D)', onSplitRight, SplitRightIcon)}
          {splitBtn('Split down', 'Split down (⇧⌘D)', onSplitDown, SplitDownIcon)}
        </div>

        <span style={{ flex: 1 }} />
        <ActivityDot active={busy} title="Terminal activity in progress" />
        <span
          title={cwd}
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: C.faint,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '45%'
          }}
        >
          {cwd}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: C.app }}>
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
                background: C.app
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
            background: C.panel,
            border: '1px solid #3E3E3A',
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
              color: C.text,
              cursor: 'pointer',
              textAlign: 'left'
            }}
          >
            <SplitRightIcon size={13} />
            <span style={{ flex: 1 }}>Split right</span>
            <span style={{ fontSize: 11, color: C.textMuted }}>⌘D</span>
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
              color: C.text,
              cursor: 'pointer',
              textAlign: 'left'
            }}
          >
            <SplitDownIcon size={13} />
            <span style={{ flex: 1 }}>Split down</span>
            <span style={{ fontSize: 11, color: C.textMuted }}>⇧⌘D</span>
          </button>
        </div>
      )}
    </div>
  )
}
