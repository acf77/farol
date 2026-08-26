import { useEffect, useRef, useState } from 'react'
import { C } from '../theme'

/**
 * Shared interactive primitives.
 *
 * DESIGN.md gives the app one button vocabulary, one segmented control and one
 * checkbox; before this file each surface grew its own. Everything here is
 * keyboard reachable and carries a visible focus ring, which inline-styled
 * <div onClick> could not.
 */

/** Heights: `sm` for toolbar chrome, `md` for primary actions (DESIGN.md button-primary). */
export type BtnSize = 'sm' | 'md'
export type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const HEIGHT: Record<BtnSize, number> = { sm: 24, md: 28 }

function variantStyle(v: BtnVariant, disabled?: boolean): React.CSSProperties {
  if (v === 'primary') {
    return {
      border: 'none',
      background: disabled ? 'rgba(47,124,246,0.35)' : C.accent,
      color: '#fff',
      fontWeight: 600
    }
  }
  if (v === 'secondary') {
    return {
      border: '1px solid rgba(255,255,255,0.12)',
      background: 'rgba(255,255,255,0.05)',
      color: C.textSoft
    }
  }
  if (v === 'danger') {
    return { border: 'none', background: 'transparent', color: C.red }
  }
  return { border: 'none', background: 'transparent', color: C.textSoft }
}

export function Button({
  variant = 'secondary',
  size = 'sm',
  children,
  className,
  style,
  ...rest
}: {
  variant?: BtnVariant
  size?: BtnSize
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const hoverClass =
    variant === 'primary' ? 'bf-btn-primary' : variant === 'danger' ? 'bf-danger' : 'bf-hover-fill'
  return (
    <button
      {...rest}
      className={`bf-focus ${hoverClass}${className ? ` ${className}` : ''}`}
      style={{
        height: HEIGHT[size],
        padding: size === 'sm' ? '0 11px' : '0 16px',
        borderRadius: size === 'sm' ? 7 : 9,
        fontSize: 12.5,
        cursor: rest.disabled ? 'default' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
        ...variantStyle(variant, rest.disabled),
        ...style
      }}
    >
      {children}
    </button>
  )
}

/**
 * A destructive action that arms on first press and commits on the second.
 *
 * Deleting a pipeline rewrites `.buildflow/pipelines.json`, a file meant to be
 * committed and shared, and there is no undo — so the button asks once, in
 * place. Escape, blur or six seconds of hesitation disarm it. A modal would be
 * the lazy answer here and DESIGN.md rules it out.
 */
export function ConfirmButton({
  onConfirm,
  label,
  confirmLabel,
  title,
  size = 'sm',
  style
}: {
  onConfirm: () => void
  label: React.ReactNode
  confirmLabel: string
  title?: string
  size?: BtnSize
  style?: React.CSSProperties
}) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const disarm = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setArmed(false)
  }

  useEffect(() => {
    if (!armed) return
    timer.current = setTimeout(() => setArmed(false), 6000)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [armed])

  if (!armed) {
    return (
      <Button variant="danger" size={size} title={title} onClick={() => setArmed(true)} style={style}>
        {label}
      </Button>
    )
  }

  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...style }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) disarm()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          disarm()
        }
      }}
    >
      <span style={{ fontSize: 11, color: C.textMuted, whiteSpace: 'nowrap' }}>{confirmLabel}</span>
      <Button
        variant="danger"
        size={size}
        autoFocus
        onClick={() => {
          disarm()
          onConfirm()
        }}
        style={{ background: 'rgba(255,69,58,0.14)' }}
      >
        Delete
      </Button>
      <Button variant="ghost" size={size} onClick={disarm}>
        Cancel
      </Button>
    </span>
  )
}

/**
 * One segmented control for the whole app. Arrow keys move between options, as
 * a radio group should — the previous native <select> in the sidebar and the
 * div-based segments on the canvas disagreed about both looks and keyboard.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  tone = 'neutral',
  label,
  style
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  tone?: 'neutral' | 'ai'
  label?: string
  style?: React.CSSProperties
}) {
  const activeBg = tone === 'ai' ? 'rgba(201,138,94,0.22)' : 'rgba(255,255,255,0.14)'
  const activeFg = tone === 'ai' ? C.purpleSoft : '#fff'

  const move = (dir: 1 | -1): void => {
    const i = options.findIndex((o) => o.value === value)
    const next = options[(i + dir + options.length) % options.length]
    if (next) onChange(next.value)
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{
        display: 'flex',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 7,
        overflow: 'hidden',
        ...style
      }}
    >
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className="bf-focus"
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                move(1)
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                move(-1)
              }
            }}
            style={{
              flex: 1,
              border: 'none',
              textAlign: 'center',
              padding: '4px 6px',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.4px',
              cursor: 'pointer',
              background: on ? activeBg : 'transparent',
              color: on ? activeFg : C.dim
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** The app's one checkbox. Both call sites previously styled their own. */
export function Checkbox({
  checked,
  onChange,
  children,
  title,
  style
}: {
  checked: boolean
  onChange: (v: boolean) => void
  children: React.ReactNode
  title?: string
  style?: React.CSSProperties
}) {
  return (
    <label
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 11.5,
        color: C.textSoft,
        cursor: 'pointer',
        ...style
      }}
    >
      <input
        type="checkbox"
        className="bf-focus"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: C.accent, margin: 0, cursor: 'pointer', flex: 'none' }}
      />
      {children}
    </label>
  )
}
