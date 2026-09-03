/** Palette sampled from Farol's charcoal desktop references. */

export const C = {
  appBg: 'oklch(0.17 0.006 95)',
  chrome: 'oklch(0.31 0.018 285)',
  terminal: 'oklch(0.18 0.004 95)',
  sidebar: 'oklch(0.23 0.005 95)',
  emptyBg: 'oklch(0.23 0.005 95)',
  panel: 'oklch(0.28 0.006 95)',

  /** Cards, tool output, suggestion tiles. */
  card: 'oklch(0.23 0.005 95)',
  cardBorder: 'oklch(0.36 0.006 95)',
  /** Chat surface panes, the message composer. */
  surface: 'oklch(0.23 0.005 95)',
  surfaceBorder: 'oklch(0.36 0.006 95)',
  border: 'oklch(0.36 0.006 95)',

  text: 'oklch(0.94 0.006 95)',
  textStrong: 'oklch(0.94 0.006 95)',
  textSoft: 'oklch(0.87 0.006 95)',
  textMuted: 'oklch(0.7 0.006 95)',
  dim: 'oklch(0.7 0.006 95)',
  faint: 'oklch(0.56 0.006 95)',
  fainter: 'oklch(0.43 0.006 95)',

  textStep: 'oklch(0.94 0.006 95)',
  textRow: 'oklch(0.8 0.006 95)',
  glyph: 'oklch(0.7 0.006 95)',

  /** Signal lime: selection, primary action, and keyboard focus. */
  accent: 'oklch(0.91 0.19 115)',
  accentHover: 'oklch(0.95 0.16 115)',
  accentBright: 'oklch(0.91 0.19 115)',
  accentSoft: 'oklch(0.95 0.16 115)',
  accentInk: 'oklch(0.18 0.025 115)',
  green: 'oklch(0.78 0.09 160)',
  red: 'oklch(0.69 0.2 25)',
  /** Lavender identifies agent and model work. */
  purple: 'oklch(0.73 0.16 300)',
  purpleSoft: 'oklch(0.84 0.1 300)',
  yellow: 'oklch(0.84 0.17 85)',
  yellowDim: 'oklch(0.48 0.1 85)',
  grey: 'oklch(0.56 0.006 95)',

  light: { red: '#FF5F57', yellow: '#FFBD2E', green: '#28C840' }
} as const

/**
 * Surfaces when native Liquid Glass is behind the window. Chrome stays lightly
 * tinted so controls read; the shell/run panes stay opaque for contrast.
 */
export const glass = {
  appBg: 'transparent',
  chrome: 'rgba(54, 55, 64, 0.58)',
  sidebar: 'rgba(35, 35, 34, 0.58)',
  emptyBg: 'rgba(35, 35, 34, 0.58)',
  tabActive: 'rgba(255, 255, 255, 0.08)',
  panel: 'rgba(45, 45, 43, 0.82)',
  terminal: '#181817',
  paneWell: '#181817'
} as const

/** Colours for Farol's own run-log lines (DESIGN.md § Run Log). */
export const LINE = {
  def: '#F0F0EC',
  dim: '#A1A19A',
  cmd: '#F7F7F2',
  head: '#D6F23A',
  step: '#F0F0EC',
  ok: '#87C9AE',
  err: '#FF625A',
  ai: '#B894FF',
  warn: '#FFBE2E',
  echo: '#C4C4BE'
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
  background: C.terminal,
  border: `1px solid ${C.border}`,
  borderRadius: 12,
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
