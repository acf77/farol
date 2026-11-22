import { useEffect, useRef, useState } from 'react'
import { EMPTY_BROWSER_STATE, type BrowserState } from '@shared/browser'
import { C, ELLIPSIS, PANE } from '../theme'
import { CaretLeft, CaretRight, RefreshIcon, StopIcon } from './icons'
import { Smartphone } from 'lucide-react'

const api = window.farol

const SOFT = 'oklch(1 0 0 / 0.06)'

/** iPhone 15 logical viewport (pt). */
const IPHONE_W = 390
const IPHONE_H = 844

function fitIphone(outerW: number, outerH: number): { width: number; height: number } {
  const scale = Math.min(1, outerW / IPHONE_W, outerH / IPHONE_H)
  return { width: Math.round(IPHONE_W * scale), height: Math.round(IPHONE_H * scale) }
}

/**
 * A minimal browser. The page is a native view that the main process lays over this pane's body:
 * the pane only reports where that body is, and hides the view whenever it should not show.
 */
export default function BrowserPane({ checkout, active }: { checkout: string; active: boolean }) {
  const outerRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<BrowserState>(EMPTY_BROWSER_STATE)
  const [draft, setDraft] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)
  const [iphone, setIphone] = useState(false)
  const [outerSize, setOuterSize] = useState({ width: 0, height: 0 })

  useEffect(() => api.browser.onState((e) => e.checkout === checkout && setState(e.state)), [checkout])

  const frame =
    iphone && outerSize.width > 0 && outerSize.height > 0
      ? fitIphone(outerSize.width, outerSize.height)
      : null

  useEffect(() => {
    const outer = outerRef.current
    const body = bodyRef.current
    if (!active || !outer || !body) return
    let live = true
    const place = (): void => {
      const outerRect = outer.getBoundingClientRect()
      setOuterSize({ width: outerRect.width, height: outerRect.height })
      const r = body.getBoundingClientRect()
      void api.browser
        .show(checkout, { x: r.left, y: r.top, width: r.width, height: r.height })
        .then((s) => live && s && setState(s))
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(outer)
    observer.observe(body)
    window.addEventListener('resize', place)
    return () => {
      live = false
      observer.disconnect()
      window.removeEventListener('resize', place)
      void api.browser.hide(checkout)
    }
  }, [active, checkout, iphone])

  const go = async (): Promise<void> => {
    if (draft === null) return
    const ok = await api.browser.navigate(checkout, draft)
    setRefused(!ok)
    if (ok) setDraft(null)
  }

  const navButton = (
    label: string,
    onClick: () => void,
    disabled: boolean,
    icon: React.ReactNode,
    pressed = false
  ) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="bf-focus bf-hover-fill"
      style={{
        width: 26,
        height: 26,
        border: 'none',
        borderRadius: 6,
        background: pressed ? SOFT : 'transparent',
        color: disabled ? C.fainter : pressed ? C.text : C.textSoft,
        cursor: disabled ? 'default' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {icon}
    </button>
  )

  return (
    <section aria-label="Browser" style={{ ...PANE, flex: 1 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 8px',
          borderBottom: `1px solid ${C.hair}`
        }}
      >
        {navButton('Back', () => void api.browser.back(checkout), !state.canGoBack, <CaretLeft size={14} />)}
        {navButton('Forward', () => void api.browser.forward(checkout), !state.canGoForward, <CaretRight size={14} />)}
        {navButton(
          state.loading ? 'Stop' : 'Reload',
          () => void api.browser.reload(checkout),
          !state.url,
          state.loading ? <StopIcon size={12} /> : <RefreshIcon size={13} />
        )}
        {navButton(
          iphone ? 'Full width' : 'iPhone size',
          () => setIphone((v) => !v),
          false,
          <Smartphone size={13} strokeWidth={iphone ? 2.25 : 1.75} />,
          iphone
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void go()
          }}
          style={{ flex: 1, minWidth: 0, display: 'flex' }}
        >
          <input
            aria-label="Address"
            aria-invalid={refused}
            spellCheck={false}
            placeholder="Enter an address, such as localhost:3000"
            value={draft ?? state.url}
            onFocus={(e) => {
              setDraft(state.url)
              e.currentTarget.select()
            }}
            onChange={(e) => {
              setDraft(e.target.value)
              setRefused(false)
            }}
            onBlur={() => setDraft(null)}
            className="bf-focus"
            style={{
              flex: 1,
              minWidth: 0,
              height: 26,
              padding: '0 10px',
              borderRadius: 6,
              border: `1px solid ${refused ? C.red : C.border}`,
              background: C.sidebar,
              color: C.text,
              fontSize: 12,
              userSelect: 'text',
              ...ELLIPSIS
            }}
          />
        </form>
      </div>
      {refused && (
        <div role="alert" style={{ padding: '4px 10px', fontSize: 11.5, color: C.red }}>
          Only http and https addresses open here.
        </div>
      )}
      <div
        ref={outerRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: iphone ? 'oklch(0 0 0 / 0.35)' : undefined
        }}
      >
        <div
          ref={bodyRef}
          style={
            frame
              ? {
                  width: frame.width,
                  height: frame.height,
                  flex: 'none',
                  borderRadius: 28,
                  border: `1px solid ${C.border}`,
                  boxShadow: '0 8px 32px oklch(0 0 0 / 0.45)',
                  overflow: 'hidden'
                }
              : { flex: 1, alignSelf: 'stretch', minHeight: 0, width: '100%' }
          }
        />
      </div>
    </section>
  )
}
