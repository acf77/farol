import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { C, MONO, UI } from '../theme'

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

/**
 * ⌘K command palette. Filters a flat action list; Enter runs the highlighted
 * row. Escape / backdrop click dismisses without side effects.
 */
export default function CommandPalette({ open, items, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((item) => {
      const hay = `${item.label} ${item.detail ?? ''} ${item.group ?? ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [items, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [open])

  useEffect(() => {
    setIndex(0)
  }, [query])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setIndex((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const item = filtered[index]
        if (item) {
          onClose()
          item.run()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, filtered, index, onClose])

  if (!open) return null

  return createPortal(
    <div
      role="dialog"
      aria-label="Command palette"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '12vh',
        background: 'rgba(4, 6, 10, 0.55)',
        fontFamily: UI
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        style={{
          width: 480,
          maxWidth: '92vw',
          background: '#111621',
          border: `1px solid ${C.cardBorder}`,
          borderRadius: 12,
          boxShadow: '0 24px 60px rgba(0,0,0,0.55)',
          overflow: 'hidden'
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search pipelines, views, actions…"
          className="bf-focus"
          style={{
            width: '100%',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: C.text,
            fontSize: 14,
            padding: '14px 16px',
            borderBottom: '1px solid #1e2532'
          }}
        />
        <div style={{ maxHeight: 320, overflow: 'auto', padding: 6 }}>
          {!filtered.length && (
            <div style={{ padding: '14px 10px', fontSize: 12.5, color: C.textMuted }}>
              No matches
            </div>
          )}
          {filtered.map((item, i) => {
            const on = i === index
            return (
              <button
                key={item.id}
                type="button"
                className="bf-focus"
                onMouseEnter={() => setIndex(i)}
                onClick={() => {
                  onClose()
                  item.run()
                }}
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'center',
                  gap: 10,
                  textAlign: 'left',
                  border: 'none',
                  borderRadius: 8,
                  padding: '9px 10px',
                  background: on ? '#1b2433' : 'transparent',
                  color: on ? C.textStrong : C.textSoft,
                  cursor: 'pointer'
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 500 }}>{item.label}</span>
                  {(item.detail || item.group) && (
                    <span
                      style={{
                        display: 'block',
                        fontSize: 11,
                        color: C.textMuted,
                        fontFamily: item.detail ? MONO : undefined,
                        marginTop: 2,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {item.group && !item.detail ? item.group : item.detail}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>,
    document.body
  )
}
