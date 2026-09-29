import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { C, MONO, UI, ELLIPSIS } from '../theme'

export interface PaletteItem {
  id: string
  label: string
  detail?: string
  group?: string
  run: () => void
}

interface Props {
  open: boolean
  items: PaletteItem[]
  onClose: () => void
}

export default function CommandPalette({ open, items, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((item) => {
      const hay = `${item.label} ${item.detail ?? ''} ${item.group ?? ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [items, query])
  const activeIndex = Math.min(index, Math.max(filtered.length - 1, 0))

  useLayoutEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement
    setQuery('')
    setIndex(0)
    dialog.showModal()
    inputRef.current?.focus({ preventScroll: true })
    return () => {
      const restore = dialog.contains(document.activeElement) || document.activeElement === document.body
      dialog.close()
      if (restore && previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true })
      }
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [open, activeIndex, filtered])

  const runItem = (item: PaletteItem): void => {
    dialogRef.current?.close()
    onClose()
    item.run()
  }

  if (!open) return null

  return createPortal(
    <dialog
      ref={dialogRef}
      className="bf-command-palette bf-page-overlay"
      aria-label="Command palette"
      onCancel={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
      onKeyDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        maxWidth: 'none',
        maxHeight: 'none',
        margin: 0,
        border: 'none',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '12vh 0 16px',
        background: 'rgba(4, 6, 10, 0.55)',
        color: C.text,
        overflow: 'auto',
        fontFamily: UI
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <style>{`
        .bf-command-palette:not([open]) { display: none !important; }
        .bf-command-palette::backdrop { background: transparent; }
        .bf-command-palette input:focus-visible {
          outline-offset: -3px !important;
          box-shadow: none !important;
        }
      `}</style>
      <div
        style={{
          width: 480,
          maxWidth: '92vw',
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: C.sidebar,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          boxShadow: '0 24px 60px rgba(0,0,0,0.55)',
          overflow: 'hidden'
        }}
      >
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Search commands"
          aria-autocomplete="list"
          aria-expanded={true}
          aria-controls={listId}
          aria-activedescendant={filtered.length ? `${listId}-${activeIndex}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex(Math.min(activeIndex + 1, Math.max(filtered.length - 1, 0)))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex(Math.max(activeIndex - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const item = filtered[activeIndex]
              if (item) runItem(item)
            } else if (e.key === 'Tab') {
              e.preventDefault()
            }
          }}
          placeholder="Search pipelines, views, actions…"
          className="bf-input bf-focus"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            flexShrink: 0,
            border: 'none',
            outline: 'none',
            outlineOffset: -3,
            background: 'transparent',
            color: C.text,
            fontSize: 13,
            padding: '14px 16px',
            borderBottom: '1px solid #3E3E3A'
          }}
        />
        <div
          id={listId}
          role="listbox"
          aria-label="Commands"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          style={{ maxHeight: 320, minHeight: 0, overflow: 'auto', padding: 6 }}
        >
          {filtered.map((item, i) => {
            const on = i === activeIndex
            return (
              <div
                key={item.id}
                id={`${listId}-${i}`}
                ref={on ? activeRef : undefined}
                role="option"
                aria-selected={on}
                onMouseEnter={() => setIndex(i)}
                onClick={() => runItem(item)}
                style={{
                  display: 'flex',
                  width: '100%',
                  boxSizing: 'border-box',
                  alignItems: 'center',
                  gap: 10,
                  textAlign: 'left',
                  border: 'none',
                  borderRadius: 8,
                  padding: '9px 10px',
                  background: on ? C.panel : 'transparent',
                  color: on ? C.text : C.textSoft,
                  cursor: 'pointer'
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{item.label}</span>
                  {(item.detail || item.group) && (
                    <span
                      style={{
                        display: 'block',
                        fontSize: 11,
                        color: C.textMuted,
                        fontFamily: item.detail ? MONO : undefined,
                        marginTop: 2,
                        ...ELLIPSIS
                      }}
                    >
                      {item.group && !item.detail ? item.group : item.detail}
                    </span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
        <div role="status" style={filtered.length ? { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' } : { padding: '14px 16px', fontSize: 12, color: C.textMuted }}>
          {filtered.length ? `${filtered.length} commands available` : 'No matches'}
        </div>
      </div>
    </dialog>,
    document.body
  )
}
