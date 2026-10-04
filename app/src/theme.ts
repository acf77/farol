/** Palette sampled from Farol's charcoal desktop references. */

export const C = {
  /** App shell and chat canvas (Pipelines Sidebar design). */
  app: 'oklch(0.17 0.006 95)',
  /** Flat side rails and panels. */
  rail: 'oklch(0.2 0.005 95)',
  /** Sunken wells: logs, code. */
  well: 'oklch(0.15 0.004 95)',
  /** Hairline between flat panes. */
  hair: 'oklch(1 0 0 / 0.07)',
  terminal: 'oklch(0.18 0.004 95)',
  sidebar: 'oklch(0.23 0.005 95)',
  panel: 'oklch(0.28 0.006 95)',

  border: 'oklch(0.36 0.006 95)',

  text: 'oklch(0.94 0.006 95)',
  textSoft: 'oklch(0.87 0.006 95)',
  textMuted: 'oklch(0.7 0.006 95)',
  faint: 'oklch(0.56 0.006 95)',
  fainter: 'oklch(0.43 0.006 95)',

  textRow: 'oklch(0.8 0.006 95)',

  /** Signal lime: selection, primary action, and keyboard focus. */
  accent: 'oklch(0.91 0.19 115)',
  accentInk: 'oklch(0.18 0.025 115)',
  green: 'oklch(0.78 0.09 160)',
  red: 'oklch(0.69 0.2 25)',
  /** Lavender identifies agent and model work. */
  purpleSoft: 'oklch(0.84 0.1 300)',
  yellow: 'oklch(0.84 0.17 85)',
  yellowDim: 'oklch(0.48 0.1 85)'
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

/**
 * The flat pane every top-level surface sits in — chat, terminal and code share
 * this shell, separated from each other by a hairline, and only their `flex`
 * and background differ.
 */
export const PANE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  background: C.app,
  overflow: 'hidden'
}

/** Single-line truncation. */
export const ELLIPSIS: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
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
