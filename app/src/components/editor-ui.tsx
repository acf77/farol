import { useId, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { C } from '../theme'

/**
 * Building blocks lifted from the Pipeline Editor design and shared with every
 * screen that uses its language (Source Control reuses them verbatim).
 */

export const HAIR = C.hair

export const fieldBox: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 7,
  background: C.app,
  border: `1px solid ${C.border}`,
  color: C.text,
  fontSize: 13,
  outline: 'none',
  userSelect: 'text'
}

export function SparkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={C.purpleSoft} aria-hidden>
      <path d="M8 1.5c.4 2.9 1.6 4.1 4.5 4.5-2.9.4-4.1 1.6-4.5 4.5-.4-2.9-1.6-4.1-4.5-4.5 2.9-.4 4.1-1.6 4.5-4.5Z" />
      <path d="M12.5 10c.2 1.3.7 1.8 2 2-1.3.2-1.8.7-2 2-.2-1.3-.7-1.8-2-2 1.3-.2 1.8-.7 2-2Z" />
    </svg>
  )
}

/** The design's inset segmented control (rail tabs, step kind, run target). */
export function Seg<T extends string>({
  options,
  value,
  onChange,
  label,
  ai
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  label: string
  ai?: boolean
}) {
  // Radio-group keyboard model: arrows move the selection, only the checked radio is tabbable.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (!step) return
    event.preventDefault()
    const index = options.findIndex((o) => o.value === value)
    const next = options[(index + step + options.length) % options.length]
    onChange(next.value)
    ;(event.currentTarget.children[options.indexOf(next)] as HTMLElement).focus()
  }
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} style={{ display: 'flex', padding: 2, borderRadius: 8, background: C.app }}>
      {options.map((o) => {
        const on = o.value === value
        const accent = ai && o.value === 'ai' ? C.purpleSoft : C.text
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className="bf-focus"
            onClick={() => onChange(o.value)}
            style={{
              flex: 1,
              textAlign: 'center',
              padding: '5px 0',
              border: 'none',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              background: on ? 'oklch(0.31 0.006 95)' : 'transparent',
              color: on ? accent : C.textMuted
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** `htmlFor` names the control the label describes; without it the label names the whole group. */
export function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  const id = useId()
  const style = { fontSize: 12, color: C.textMuted }
  return (
    <div
      role={htmlFor ? undefined : 'group'}
      aria-labelledby={htmlFor ? undefined : id}
      style={{ display: 'flex', flexDirection: 'column', gap: 7 }}
    >
      {htmlFor ? <label htmlFor={htmlFor} style={style}>{label}</label> : <span id={id} style={style}>{label}</span>}
      {children}
    </div>
  )
}

export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {title ? (
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', color: C.faint, marginBottom: 6 }}>{title}</span>
      ) : null}
      <div style={{ borderRadius: 9, background: C.app, border: '1px solid oklch(1 0 0 / 0.06)' }}>{children}</div>
    </div>
  )
}
