import type { Segment } from '@shared/types'

/**
 * An incremental ANSI parser with a real cursor.
 *
 * Output arrives in arbitrary chunks that can split an escape sequence down
 * the middle, so parser state (pending bytes, current SGR, cursor column)
 * lives in `TermState` and every write returns a new state. It stays pure,
 * which is what lets it run inside a React state updater.
 *
 * Rows are arrays of cells rather than appended strings, because programs
 * place text with cursor moves (`ESC[12C`, `ESC[;40H`) instead of spaces.
 * Appending would run the words together; writing at a column does not.
 *
 * This models one line at a time, not a screen. Programs that take over the
 * display with the alternate screen buffer (vim, htop, an interactive agent)
 * are detected and reported rather than rendered as garbage.
 */

export const DEFAULT_FG = '#F8FAFC'

const BASIC = [
  '#64748B', // black
  '#EF4444', // red
  '#22C55E', // green
  '#F59E0B', // yellow
  '#60A5FA', // blue (Soft Blue — AA on Deep Navy)
  '#bf5af2', // magenta (AI violet)
  '#38BDF8', // cyan
  '#F8FAFC' // white
]

const BRIGHT = [
  '#94A3B8',
  '#F87171',
  '#4ADE80',
  '#FBBF24',
  '#93C5FD',
  '#d7a5f7',
  '#BAE6FD',
  '#FFFFFF'
]

function xterm256(n: number): string {
  if (n < 16) return n < 8 ? BASIC[n] : BRIGHT[n - 8]
  if (n < 232) {
    const i = n - 16
    const level = (v: number): number => (v === 0 ? 0 : 55 + v * 40)
    return `rgb(${level(Math.floor(i / 36) % 6)},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`
  }
  const v = 8 + (n - 232) * 10
  return `rgb(${v},${v},${v})`
}

export interface Sgr {
  color?: string
  bold?: boolean
  dim?: boolean
}

export interface Cell {
  ch: string
  color?: string
  bold?: boolean
  dim?: boolean
}

export type Row = Cell[]

export interface TermState {
  rows: Row[]
  sgr: Sgr
  /** Bytes held back because they may be the start of an escape sequence. */
  pending: string
  /** Prefix applied at the start of each new row (indents streamed step output). */
  indent: string
  /** Cursor column within the last row. */
  col: number
  /** A program has taken over the display with the alternate screen. */
  altScreen: boolean
}

const BLANK: Cell = { ch: ' ' }

/** Soft cap on cells per row — unbounded lines turn each byte into a heap object. */
export const MAX_COLS = 512

export function emptyTerm(): TermState {
  return { rows: [[]], sgr: {}, pending: '', indent: '', col: 0, altScreen: false }
}

/** Collapse a row into styled runs for rendering, dropping trailing blanks. */
export function segments(row: Row): Segment[] {
  let end = row.length
  while (end > 0 && row[end - 1].ch === ' ' && !row[end - 1].color) end--

  const out: Segment[] = []
  for (let i = 0; i < end; i++) {
    const c = row[i]
    const last = out[out.length - 1]
    if (last && last.color === c.color && !!last.bold === !!c.bold && !!last.dim === !!c.dim) {
      last.text += c.ch
    } else {
      out.push({ text: c.ch, color: c.color, bold: c.bold, dim: c.dim })
    }
  }
  return out
}

export function rowText(row: Row): string {
  return row.map((c) => c.ch).join('')
}

/** Parse 38/48 extended colour params starting at `modeIdx`; returns colour + codes consumed after the 38/48. */
function parseExtendedColor(codes: number[], modeIdx: number): { color: string | undefined; consumed: number } {
  const mode = codes[modeIdx]
  if (mode === 5) {
    return { color: xterm256(codes[modeIdx + 1] ?? 0), consumed: 2 }
  }
  if (mode === 2) {
    return {
      color: `rgb(${codes[modeIdx + 1] ?? 0},${codes[modeIdx + 2] ?? 0},${codes[modeIdx + 3] ?? 0})`,
      consumed: 4
    }
  }
  return { color: undefined, consumed: 0 }
}

/** Apply a single SGR code; returns extra codes to skip (for 38/48 sequences). */
function applyOneSgr(next: Sgr, c: number, codes: number[], i: number): { next: Sgr; skip: number } {
  if (c === 0) return { next: {}, skip: 0 }
  if (c === 1) {
    next.bold = true
    return { next, skip: 0 }
  }
  if (c === 2) {
    next.dim = true
    return { next, skip: 0 }
  }
  if (c === 22) {
    next.bold = false
    next.dim = false
    return { next, skip: 0 }
  }
  if (c >= 30 && c <= 37) {
    next.color = BASIC[c - 30]
    return { next, skip: 0 }
  }
  if (c >= 90 && c <= 97) {
    next.color = BRIGHT[c - 90]
    return { next, skip: 0 }
  }
  if (c === 39) {
    next.color = undefined
    return { next, skip: 0 }
  }
  if (c === 38 || c === 48) {
    const { color, consumed } = parseExtendedColor(codes, i + 1)
    if (c === 38 && color) next.color = color
    return { next, skip: consumed }
  }
  return { next, skip: 0 }
}

function applySgr(sgr: Sgr, params: string): Sgr {
  const codes = params.split(';').map((p) => (p === '' ? 0 : parseInt(p, 10)))
  let next: Sgr = { ...sgr }
  for (let i = 0; i < codes.length; i++) {
    const result = applyOneSgr(next, codes[i], codes, i)
    next = result.next
    i += result.skip
  }
  return next
}

const CSI_FINAL = /[@-~]/
/** Longest escape we will hold waiting for the rest of it. */
const MAX_PENDING = 512

/**
 * How to treat `\x1b...` at the head of the buffer: consume a complete
 * sequence, wait for more bytes, or give up on a malformed one.
 */
function readEscape(rest: string): { kind: 'csi' | 'osc' | 'esc'; seq: string } | 'incomplete' | null {
  if (rest.length === 1) return 'incomplete'

  const second = rest[1]

  if (second === '[') {
    for (let i = 2; i < rest.length; i++) {
      if (CSI_FINAL.test(rest[i])) return { kind: 'csi', seq: rest.slice(0, i + 1) }
    }
    // No final byte yet — a truecolour SGR is ~20 chars, so keep waiting.
    return rest.length < MAX_PENDING ? 'incomplete' : null
  }

  if (second === ']') {
    const bel = rest.indexOf('\x07', 2)
    const st = rest.indexOf('\x1b\\', 2)
    const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
    if (end === -1) return rest.length < MAX_PENDING ? 'incomplete' : null
    return { kind: 'osc', seq: rest.slice(0, end + (rest[end] === '\x07' ? 1 : 2)) }
  }

  // Charset selection and similar two/three byte escapes.
  if ('()#%'.includes(second)) {
    if (rest.length < 3) return 'incomplete'
    return { kind: 'esc', seq: rest.slice(0, 3) }
  }
  if ('=>78MDEHc'.includes(second)) return { kind: 'esc', seq: rest.slice(0, 2) }

  return null
}

interface Writer {
  rows: Row[]
  cur: Cell[]
  sgr: Sgr
  col: number
  indent: string
  alt: boolean
}

function note(w: Writer, text: string): void {
  if (w.cur.length) {
    w.cur = []
    w.rows.push(w.cur)
  }
  for (const ch of text) w.cur.push({ ch, color: '#94A3B8' })
  w.cur = []
  w.rows.push(w.cur)
  w.col = 0
}

function newline(w: Writer): void {
  w.cur = []
  w.rows.push(w.cur)
  w.col = 0
  for (const ch of w.indent) w.cur.push({ ch })
  w.col = w.indent.length
}

/** Write one character at the cursor, padding with blanks to reach it. */
function put(w: Writer, ch: string): void {
  if (w.col >= MAX_COLS) return
  while (w.cur.length < w.col) w.cur.push({ ...BLANK })
  w.cur[w.col] = { ch, color: w.sgr.color, bold: w.sgr.bold, dim: w.sgr.dim }
  w.col++
}

function eraseInLine(cur: Cell[], col: number, n: number | undefined): void {
  if (n === 1) for (let k = 0; k < col && k < cur.length; k++) cur[k] = { ...BLANK }
  else if (n === 2) cur.length = 0
  else cur.length = Math.min(cur.length, col)
}

function eraseChars(cur: Cell[], col: number, n: number | undefined): void {
  const count = Math.max(1, n ?? 1)
  const end = Math.min(MAX_COLS, col + count)
  while (cur.length < end) cur.push({ ...BLANK })
  for (let k = col; k < end; k++) cur[k] = { ...BLANK }
}

function applyCursorMove(col: number, final: string, nums: number[], n: number | undefined): number {
  switch (final) {
    case 'C': // cursor forward
      return Math.min(MAX_COLS, col + Math.max(1, n ?? 1))
    case 'D': // cursor back
      return Math.max(0, col - Math.max(1, n ?? 1))
    case 'G': // cursor to column
    case '`':
      return Math.max(0, Math.min(MAX_COLS, (n ?? 1) - 1))
    case 'H': // cursor position — only the column applies to a line buffer
    case 'f': {
      const c = Number.isFinite(nums[1]) ? nums[1] : 1
      return Math.max(0, Math.min(MAX_COLS, c - 1))
    }
    default:
      return col
  }
}

const ALT_SCREEN_MODES = new Set([1049, 1047, 47])

/** Handle DEC private mode CSI (?…h / ?…l), e.g. alternate screen. */
function handlePrivateCsi(w: Writer, final: string, n: number | undefined): void {
  if (final === 'h' && n !== undefined && ALT_SCREEN_MODES.has(n)) {
    if (!w.alt) {
      w.alt = true
      note(w, '[full-screen program — output not shown in this pane]')
    }
  } else if (final === 'l' && n !== undefined && ALT_SCREEN_MODES.has(n)) {
    w.alt = false
  }
}

function applyCsi(w: Writer, seq: string): void {
  const final = seq[seq.length - 1]
  const body = seq.slice(2, -1)
  const priv = body.startsWith('?')
  const nums = (priv ? body.slice(1) : body).split(';').map((p) => parseInt(p, 10))
  const n = Number.isFinite(nums[0]) ? nums[0] : undefined

  if (priv) {
    handlePrivateCsi(w, final, n)
    return
  }
  if (w.alt) return

  switch (final) {
    case 'm':
      w.sgr = applySgr(w.sgr, body)
      break
    case 'C':
    case 'D':
    case 'G':
    case '`':
    case 'H':
    case 'f':
      w.col = applyCursorMove(w.col, final, nums, n)
      break
    case 'K': // erase in line
      eraseInLine(w.cur, w.col, n)
      break
    case 'X': // erase n characters
      eraseChars(w.cur, w.col, n)
      break
    default:
      break
  }
}

/**
 * Consume an escape at `buf[i]`. Returns next index, or -1 if the rest is
 * incomplete (caller should stash `buf.slice(i)` as pending).
 */
function handleEscape(w: Writer, buf: string, i: number): number {
  const rest = buf.slice(i)
  const read = readEscape(rest)
  if (read === 'incomplete') return -1
  if (read === null) return i + 1

  const { kind, seq } = read
  const next = i + seq.length
  if (kind === 'csi') applyCsi(w, seq)
  return next
}

/** Handle a single printable/control character. Returns bytes consumed (always 1). */
function handleByte(w: Writer, ch: string): void {
  if (w.alt) return

  if (ch === '\n') {
    newline(w)
    return
  }
  if (ch === '\r') {
    w.col = 0
    return
  }
  if (ch === '\b') {
    w.col = Math.max(0, w.col - 1)
    return
  }
  if (ch === '\t') {
    const target = Math.min(MAX_COLS, w.col + (8 - (w.col % 8)))
    while (w.col < target) put(w, ' ')
    return
  }
  if (ch < ' ' || ch === '\x7f') return

  put(w, ch)
}

export function write(state: TermState, chunk: string): TermState {
  const buf = state.pending + chunk
  const rows = state.rows.slice()
  if (rows.length === 0) rows.push([])
  const cur = rows[rows.length - 1].map((c) => ({ ...c }))
  rows[rows.length - 1] = cur

  const w: Writer = {
    rows,
    cur,
    sgr: state.sgr,
    col: state.col,
    indent: state.indent,
    alt: state.altScreen
  }

  let pending = ''
  let i = 0
  while (i < buf.length) {
    const ch = buf[i]
    if (ch === '\x1b') {
      const next = handleEscape(w, buf, i)
      if (next < 0) {
        pending = buf.slice(i)
        break
      }
      i = next
      continue
    }
    handleByte(w, ch)
    i++
  }

  // Keep last-row reference in sync — helpers may have replaced `w.cur`.
  w.rows[w.rows.length - 1] = w.cur

  return { rows: w.rows, sgr: w.sgr, pending, indent: w.indent, col: w.col, altScreen: w.alt }
}

/** Write a whole styled line of Farol's own text (run logs, echoes). */
export function writeLine(state: TermState, text: string, style: Omit<Segment, 'text'>): TermState {
  const rows = state.rows.slice()
  const last = rows[rows.length - 1]
  if (!last) rows.push([])
  else if (last.length > 0) rows.push([])

  rows[rows.length - 1] = text
    ? [...text.slice(0, MAX_COLS)].map((ch) => ({
        ch,
        color: style.color,
        bold: style.bold,
        dim: style.dim
      }))
    : []
  rows.push([])
  return { ...state, rows, sgr: {}, col: 0 }
}

/** Make sure subsequent writes start on a fresh line. */
export function ensureNewline(state: TermState): TermState {
  const last = state.rows[state.rows.length - 1]
  if (!last || last.length === 0) return { ...state, col: last ? state.col : 0 }
  return { ...state, rows: [...state.rows, []], col: 0 }
}

/** Indent every new row — used while a pipeline step is streaming. */
export function setIndent(state: TermState, indent: string): TermState {
  const rows = state.rows.slice()
  let col = state.col
  const last = rows[rows.length - 1]
  if (last && last.length === 0 && indent) {
    rows[rows.length - 1] = [...indent].map((ch) => ({ ch }))
    col = indent.length
  }
  return { ...state, rows, indent, col }
}

/**
 * Stop indenting. If the current row holds nothing but the indent, drop it —
 * otherwise it shows up as a blank line.
 */
export function clearIndent(state: TermState): TermState {
  const rows = state.rows.slice()
  const last = rows[rows.length - 1]
  let col = state.col
  if (last && last.length > 0 && last.every((c) => c.ch === ' ')) {
    rows[rows.length - 1] = []
    col = 0
  }
  return { ...state, rows, indent: '', col }
}

export function trimTo(state: TermState, max: number): TermState {
  if (state.rows.length <= max) return state
  return { ...state, rows: state.rows.slice(state.rows.length - max) }
}
