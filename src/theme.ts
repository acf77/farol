/** Palette and type ramp — farol.sh Color Palette. */

export const C = {
  appBg: '#080D17',
  chrome: 'transparent',
  terminal: '#080D17',
  sidebar: '#111827',
  emptyBg: '#111827',
  panel: '#1F2937',

  /** Cards, tool output, suggestion tiles. */
  card: '#111827',
  cardBorder: '#273449',
  /** Chat surface panes, the message composer. */
  surface: '#111827',
  surfaceBorder: '#273449',
  border: '#273449',

  text: '#F8FAFC',
  textStrong: '#F8FAFC',
  textSoft: '#E2E8F0',
  textMuted: '#94A3B8',
  dim: '#94A3B8',
  faint: '#64748B',
  fainter: '#475569',

  textStep: '#F8FAFC',
  textRow: '#CBD5E1',
  glyph: '#94A3B8',

  /** Beacon Blue — fills, borders, focus rings (not body text on dark grounds). */
  accent: '#2563EB',
  accentHover: '#60A5FA',
  /** Soft Blue — blue *text* on dark grounds (WCAG AA). */
  accentBright: '#60A5FA',
  accentSoft: '#60A5FA',
  green: '#22C55E',
  red: '#EF4444',
  /** AI step identity — violet, never copper. */
  purple: '#bf5af2',
  purpleSoft: '#d7a5f7',
  yellow: '#F59E0B',
  yellowDim: '#92400E',
  grey: '#64748B',

  light: { red: '#EF4444', yellow: '#F59E0B', green: '#22C55E' }
} as const

/**
 * Surfaces when native Liquid Glass is behind the window. Chrome stays lightly
 * tinted so controls read; the shell/run panes stay opaque for contrast.
 */
export const glass = {
  appBg: 'transparent',
  chrome: 'rgba(8, 13, 23, 0.4)',
  sidebar: 'rgba(17, 24, 39, 0.4)',
  emptyBg: 'rgba(17, 24, 39, 0.4)',
  tabActive: 'rgba(255, 255, 255, 0.08)',
  panel: 'rgba(31, 41, 55, 0.72)',
  /** Terminal / run content — keep solid (Deep Navy). */
  terminal: '#080D17',
  paneWell: '#080D17'
} as const

/** Colours for Farol's own run-log lines (DESIGN.md § Run Log). */
export const LINE = {
  def: '#F8FAFC',
  dim: '#94A3B8',
  cmd: '#FFFFFF',
  head: '#60A5FA',
  step: '#F8FAFC',
  ok: '#22C55E',
  err: '#EF4444',
  ai: '#bf5af2',
  warn: '#F59E0B',
  echo: '#CBD5E1'
} as const

export type LineKind = keyof typeof LINE

/** Flat window ground. Depth comes from surface stacking, not a wash. */
export const GRADIENT_BG = C.appBg

/**
 * The floating panel every top-level surface sits in — chat, terminal and the
 * pipelines rail all share this shell, and only their `flex` and background
 * differ.
 */
export const PANE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  background: C.sidebar,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  overflow: 'hidden'
}

export const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, monospace'
export const UI =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif'

export function seg(kind: LineKind) {
  return {
    color: LINE[kind],
    bold: kind === 'cmd' || kind === 'head' || kind === 'step'
  }
}
