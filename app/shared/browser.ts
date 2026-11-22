/** Pure helpers and shapes for the Browser panel. */

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserEvent {
  checkout: string
  state: BrowserState
}

export const EMPTY_BROWSER_STATE: BrowserState = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false
}

const MAX_BOUND = 20000

/** True when `url` parses as http or https. */
export function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** An http(s) URL from what a person typed, or null. `localhost:3000` and `3000` open on this machine. */
export function normalizeBrowserUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (!text || /\s/.test(text)) return null
  const withScheme = /^\d{2,5}$/.test(text)
    ? `http://localhost:${text}`
    : /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
      ? text
      : /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(text)
        ? `http://${text}`
        : `https://${text}`
  try {
    const url = new URL(withScheme)
    return isHttpUrl(url.href) ? url.href : null
  } catch {
    return null
  }
}

/** Whole-pixel bounds, or null when any number is missing, not finite, or out of range. */
export function parseBrowserBounds(raw: unknown): BrowserBounds | null {
  if (!raw || typeof raw !== 'object') return null
  const { x, y, width, height } = raw as Record<string, unknown>
  const values = [x, y, width, height]
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_BOUND)) return null
  const [rx, ry, rw, rh] = (values as number[]).map(Math.round)
  return { x: rx, y: ry, width: Math.max(0, rw), height: Math.max(0, rh) }
}
