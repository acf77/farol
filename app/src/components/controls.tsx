import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import {
  AI_LABELS,
  aiModelLabel,
  aiSelectionLabel,
  normalizeAi,
  normalizeModel,
  pickerProviders,
  providerModels,
  type AiModel,
  type AiProvider
} from '@shared/ai'
import { filterModels, groupModels } from '@shared/agent-models'
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
      background: disabled ? 'rgba(214, 242, 58, 0.28)' : C.accent,
      color: C.accentInk,
      fontWeight: 600
    }
  }
  if (v === 'secondary') {
    return {
      border: '1px solid #3E3E3A',
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
        borderRadius: size === 'sm' ? 8 : 12,
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
        style={{ background: 'rgba(255, 98, 90,0.14)' }}
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
  const activeBg = tone === 'ai' ? 'rgba(184, 148, 255,0.22)' : 'rgba(255,255,255,0.14)'
  const activeFg = tone === 'ai' ? C.purpleSoft : '#fff'
  const buttons = useRef(new Map<T, HTMLButtonElement>())

  const move = (dir: 1 | -1): T | undefined => {
    const i = options.findIndex((o) => o.value === value)
    const next = options[(i + dir + options.length) % options.length]
    if (!next) return undefined
    onChange(next.value)
    return next.value
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{
        display: 'flex',
        border: '1px solid #3E3E3A',
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
            ref={(node) => {
              if (node) buttons.current.set(o.value, node)
              else buttons.current.delete(o.value)
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className="bf-focus"
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                const next = move(1)
                if (next) buttons.current.get(next)?.focus()
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                const next = move(-1)
                if (next) buttons.current.get(next)?.focus()
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

type MenuPos = { left: number; width: number; maxHeight: number } & ({ top: number } | { bottom: number })

export const CLI_MODEL_MENU_WIDTH = 260

const menuItem: React.CSSProperties = {
  display: 'flex',
  width: '100%',
  justifyContent: 'space-between',
  alignItems: 'center',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer'
}

function ModelMenuItem({
  label,
  selected,
  onPick
}: {
  label: string
  selected: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="bf-focus bf-menu-item"
      onClick={onPick}
      style={{ ...menuItem, color: selected ? C.textStrong : C.textMuted }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {selected && <CheckIcon size={12} />}
    </button>
  )
}

function ModelList({
  page,
  current,
  selectedModel,
  query,
  listed,
  onPick
}: {
  page: AiProvider
  current: AiProvider
  selectedModel?: string
  query: string
  listed: readonly AiModel[]
  onPick: (provider: AiProvider, model: string | undefined) => void
}) {
  const selectedId = page === 'cursor' ? (selectedModel ?? 'auto') : selectedModel
  const filtered = filterModels(listed, query)
  const selectedRow = listed.find((m) => m.id === selectedId)
  const visible =
    selectedRow && !filtered.some((m) => m.id === selectedRow.id) ? [selectedRow, ...filtered] : filtered
  const groups = groupModels(visible)
  const showHeaders = groups.length > 1 && groups.some((g) => g.key)
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {page !== 'cursor' && !query.trim() && (
        <ModelMenuItem
          label="Default"
          selected={page === current && !selectedModel}
          onPick={() => onPick(page, undefined)}
        />
      )}
      {visible.length === 0 && (
        <div style={{ padding: '8px 10px', fontSize: 12, color: C.faint }}>No matching models</div>
      )}
      {groups.map((group) => (
        <div key={group.key || 'models'}>
          {showHeaders && group.label ? (
            <div
              style={{
                padding: '6px 10px 2px',
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: C.faint
              }}
            >
              {group.label}
            </div>
          ) : null}
          {group.models.map((m) => (
            <ModelMenuItem
              key={m.id}
              label={m.label}
              selected={page === current && selectedId === m.id}
              onPick={() => onPick(page, m.id)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Two-step picker: choose a provider, then one of its supported model ids.
 * `Default` leaves model selection to that provider; Cursor's default is Auto.
 * `locked` skips the provider page — Settings default-model rows stay on one CLI.
 */
export function CliModelMenu({
  provider,
  model,
  pos,
  settings,
  only,
  locked,
  onPick,
  onClose
}: {
  provider: AiProvider
  model?: string
  pos: MenuPos
  settings?: AppSettings
  /** Narrows the provider page — Plan mode only offers review-gated CLIs. */
  only?: (provider: AiProvider) => boolean
  locked?: boolean
  onPick: (provider: AiProvider, model: string | undefined) => void
  onClose: () => void
}) {
  const current = normalizeAi(provider)
  const [page, setPage] = useState<AiProvider | 'cli'>(locked ? current : 'cli')
  const [query, setQuery] = useState('')
  const selectedModel = normalizeModel(model)
  const all = pickerProviders(settings?.openrouter)
  const providers = only ? all.filter(only) : all

  const place: React.CSSProperties =
    'bottom' in pos ? { left: pos.left, bottom: pos.bottom } : { left: pos.left, top: pos.top }

  const listed =
    page === 'cli' ? [] : providerModels(page, page === current ? selectedModel : undefined, settings)

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
        aria-label={page === 'cli' ? 'Provider' : `${AI_LABELS[page]} model`}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('input')) return
          e.preventDefault()
        }}
        style={{
          position: 'fixed',
          ...place,
          zIndex: 70,
          width: `min(${pos.width}px, calc(100vw - 16px))`,
          maxHeight: pos.maxHeight,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: C.panel,
          border: `1px solid ${C.cardBorder}`,
          borderRadius: 8,
          boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
          padding: 4
        }}
      >
        {page === 'cli'
          ? providers.map((p) => (
              <button
                key={p}
                type="button"
                role="menuitem"
                className="bf-focus bf-menu-item"
                onClick={() => {
                  setQuery('')
                  setPage(p)
                }}
                style={{
                  ...menuItem,
                  color: p === current ? C.textStrong : C.textMuted
                }}
              >
                <span>{AI_LABELS[p]}</span>
                <ChevronRight size={11} color="currentColor" />
              </button>
            ))
          : (
              <>
                {!locked && (
                  <button
                    type="button"
                    role="menuitem"
                    className="bf-focus bf-menu-item"
                    onClick={() => {
                      setQuery('')
                      setPage('cli')
                    }}
                    style={{
                      ...menuItem,
                      justifyContent: 'flex-start',
                      gap: 6,
                      color: C.textMuted,
                      flex: 'none'
                    }}
                  >
                    <CaretLeft size={12} />
                    <span>{AI_LABELS[page]}</span>
                  </button>
                )}
                <input
                  className="bf-input bf-focus"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter models…"
                  spellCheck={false}
                  aria-label="Filter models"
                  style={{
                    height: 24,
                    margin: '4px 4px 6px',
                    padding: '0 8px',
                    borderRadius: 6,
                    border: `1px solid ${C.cardBorder}`,
                    background: C.terminal,
                    color: C.text,
                    fontSize: 12,
                    flex: 'none'
                  }}
                />
                <ModelList
                  page={page}
                  current={current}
                  selectedModel={selectedModel}
                  query={query}
                  listed={listed}
                  onPick={onPick}
                />
              </>
            )}
      </div>
    </>
  )
}

/** Inspector-style trigger that opens {@link CliModelMenu} under the field. */
export function CliModelDropdown({
  provider,
  model,
  settings,
  only,
  locked,
  onChange,
  label
}: {
  provider: AiProvider
  model?: string
  settings?: AppSettings
  only?: (provider: AiProvider) => boolean
  locked?: boolean
  onChange: (provider: AiProvider, model: string | undefined) => void
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<MenuPos | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const listed = providerModels(provider, model, settings)
  const trigger = locked
    ? (aiModelLabel(provider, model, listed) ?? 'Default — the CLI decides')
    : aiSelectionLabel(provider, model, listed)

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(Math.max(rect.width, CLI_MODEL_MENU_WIDTH), window.innerWidth - 16)
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    const below = window.innerHeight - rect.bottom
    const maxHeight = Math.max(220, (below >= 220 ? below : rect.top) - 12)
    setPos(
      below >= 220
        ? { left, top: rect.bottom + 4, width, maxHeight }
        : { left, bottom: Math.max(8, window.innerHeight - rect.top + 4), width, maxHeight }
    )
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
          {trigger}
        </span>
        <ChevronDown size={10} color={C.textMuted} />
      </button>
      {open && pos && (
        <CliModelMenu
          provider={provider}
          model={model}
          settings={settings}
          only={only}
          locked={locked}
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
