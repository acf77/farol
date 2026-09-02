import { useEffect, useRef, useState } from 'react'
import {
  AI_LABELS,
  AI_PROVIDERS,
  aiSelectionLabel,
  modelsFor,
  normalizeAi,
  normalizeModel,
  type AiProvider
} from '@shared/ai'
import { C } from '../theme'
import { CaretLeft, CheckIcon, ChevronDown, ChevronRight } from './icons'

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
      background: disabled ? 'rgba(37,99,235,0.35)' : C.accent,
      color: '#fff',
      fontWeight: 600
    }
  }
  if (v === 'secondary') {
    return {
      border: '1px solid #273449',
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
 * Deleting a pipeline rewrites `.farol/pipelines.json`, a file meant to be
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
        style={{ background: 'rgba(239,68,68,0.14)' }}
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
  const activeBg = tone === 'ai' ? 'rgba(191,90,242,0.22)' : 'rgba(255,255,255,0.14)'
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
        border: '1px solid #273449',
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

type MenuPos = { left: number; width: number } & ({ top: number } | { bottom: number })

/**
 * Two-step picker: choose a CLI, then a model that CLI accepts.
 * `Default` omits `--model` so the binary uses its own setting.
 */
export function CliModelMenu({
  provider,
  model,
  pos,
  onPick,
  onClose
}: {
  provider: AiProvider
  model?: string
  pos: MenuPos
  onPick: (provider: AiProvider, model: string | undefined) => void
  onClose: () => void
}) {
  const [page, setPage] = useState<AiProvider | 'cli'>('cli')
  const current = normalizeAi(provider)
  const selectedModel = normalizeModel(model)

  const place: React.CSSProperties =
    'bottom' in pos ? { left: pos.left, bottom: pos.bottom } : { left: pos.left, top: pos.top }

  return (
    <>
      <div
        aria-hidden
        onMouseDown={(e) => {
          e.preventDefault()
          onClose()
        }}
        style={{ position: 'fixed', inset: 0, zIndex: 65 }}
      />
      <div
        role="menu"
        aria-label={page === 'cli' ? 'CLI' : `${AI_LABELS[page]} model`}
        onMouseDown={(e) => e.preventDefault()}
        style={{
          position: 'fixed',
          ...place,
          zIndex: 70,
          width: pos.width,
          background: C.panel,
          border: `1px solid ${C.cardBorder}`,
          borderRadius: 8,
          boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
          padding: 4
        }}
      >
        {page === 'cli'
          ? AI_PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                role="menuitem"
                className="bf-focus bf-menu-item"
                onClick={() => setPage(p)}
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  border: 'none',
                  background: 'transparent',
                  color: p === current ? C.textStrong : C.textMuted,
                  cursor: 'pointer'
                }}
              >
                <span>{AI_LABELS[p]}</span>
                <ChevronRight size={11} color="currentColor" />
              </button>
            ))
          : [
              <button
                key="back"
                type="button"
                role="menuitem"
                className="bf-focus bf-menu-item"
                onClick={() => setPage('cli')}
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'center',
                  gap: 6,
                  border: 'none',
                  background: 'transparent',
                  color: C.textMuted,
                  cursor: 'pointer'
                }}
              >
                <CaretLeft size={12} />
                <span>{AI_LABELS[page]}</span>
              </button>,
              <button
                key="default"
                type="button"
                role="menuitem"
                className="bf-focus bf-menu-item"
                onClick={() => onPick(page, undefined)}
                style={{
                  display: 'flex',
                  width: '100%',
                  justifyContent: 'space-between',
                  border: 'none',
                  background: 'transparent',
                  color: page === current && !selectedModel ? C.textStrong : C.textMuted,
                  cursor: 'pointer'
                }}
              >
                <span>Default</span>
                {page === current && !selectedModel && <CheckIcon size={12} />}
              </button>,
              ...modelsFor(page, page === current ? selectedModel : undefined).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="menuitem"
                  className="bf-focus bf-menu-item"
                  onClick={() => onPick(page, m.id)}
                  style={{
                    display: 'flex',
                    width: '100%',
                    justifyContent: 'space-between',
                    border: 'none',
                    background: 'transparent',
                    color: page === current && selectedModel === m.id ? C.textStrong : C.textMuted,
                    cursor: 'pointer'
                  }}
                >
                  <span>{m.label}</span>
                  {page === current && selectedModel === m.id && <CheckIcon size={12} />}
                </button>
              ))
            ]}
      </div>
    </>
  )
}

/** Inspector-style trigger that opens {@link CliModelMenu} under the field. */
export function CliModelDropdown({
  provider,
  model,
  onChange,
  label
}: {
  provider: AiProvider
  model?: string
  onChange: (provider: AiProvider, model: string | undefined) => void
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<MenuPos | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos({ left: rect.left, top: rect.bottom + 4, width: Math.max(rect.width, 168) })
    setOpen(true)
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="bf-focus"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={toggle}
        style={{
          height: 24,
          padding: '0 8px',
          borderRadius: 5,
          border: '1px solid rgba(255,255,255,0.1)',
          background: 'rgba(255,255,255,0.05)',
          color: C.text,
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          cursor: 'pointer',
          width: '100%',
          textAlign: 'left'
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {aiSelectionLabel(provider, model)}
        </span>
        <ChevronDown size={10} color={C.textMuted} />
      </button>
      {open && pos && (
        <CliModelMenu
          provider={provider}
          model={model}
          pos={pos}
          onPick={(p, m) => {
            onChange(p, m)
            setOpen(false)
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
