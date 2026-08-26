/** Palette and type ramp — matches the "Forge" design spec (claude.ai/design). */

export const C = {
  appBg: '#07090d',
  chrome: 'transparent',
  terminal: '#0b0f16',
  sidebar: '#0e121a',
  emptyBg: '#0a0d13',
  tabActive: '#212a39',
  panel: '#0e121a',

  /** Cards, tool output, suggestion tiles. */
  card: '#12171f',
  cardBorder: '#232a38',
  /** Chat surface panes, the message composer. */
  surface: '#141922',
  surfaceBorder: '#262e3d',
  border: '#1e2532',

  text: '#e7eaf0',
  textStrong: '#eef1f6',
  textSoft: '#dfe4ec',
  textMuted: '#8b94a3',
  dim: '#7f889a',
  faint: '#6d7686',
  fainter: '#5c6577',

  textStep: '#e7eaf0',
  textRow: '#c3cad6',
  glyph: '#8f98a8',

  accent: '#2f7cf6',
  accentHover: '#3b88ff',
  accentBright: '#4d8dfb',
  accentSoft: '#c3cad6',
  green: '#5fd39a',
  red: '#e07b7b',
  /** Agent identity colour — the sparkle mark, its avatar ring. */
  purple: '#c98a5e',
  purpleSoft: '#e3b892',
  yellow: '#e2b258',
  yellowDim: '#8e6b2f',
  grey: '#3a4356',

  light: { red: '#ff5f57', yellow: '#febc2e', green: '#28c840' }
} as const

/**
 * Surfaces when native Liquid Glass is behind the window. Chrome stays lightly
 * tinted so controls read; the shell/run panes stay opaque for contrast.
 */
export const glass = {
  appBg: 'transparent',
  chrome: 'rgba(14, 18, 26, 0.5)',
  sidebar: 'rgba(14, 18, 26, 0.45)',
  emptyBg: 'rgba(10, 13, 19, 0.4)',
  tabActive: 'rgba(255, 255, 255, 0.08)',
  panel: 'rgba(17, 22, 31, 0.75)',
  /** Terminal / run content — keep solid. */
  terminal: '#0b0f16',
  paneWell: '#0b0f16'
} as const

/** Colours for BuildFlow's own run-log lines (the design's `this.C`). */
export const LINE = {
  def: '#dfe4ec',
  dim: '#6d7686',
  cmd: '#ffffff',
  head: '#4d8dfb',
  step: '#e7eaf0',
  ok: '#5fd39a',
  err: '#e07b7b',
  ai: '#c98a5e',
  warn: '#e2b258',
  echo: '#c3cad6'
} as const

export type LineKind = keyof typeof LINE

/** The app's window background — a faint glow rising from the top edge. */
export const GRADIENT_BG =
  'radial-gradient(1200px 500px at 50% -10%, #131b2b 0%, #0a0d13 55%, #07090d 100%)'

/**
 * The floating panel every top-level surface sits in — chat, terminal and the
 * pipelines rail all share this shell, and only their `flex` and background
 * differ. Lifted verbatim from the spec's `pane` object.
 */
export const PANE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  background: '#0e121a',
  border: '1px solid #1e2532',
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
