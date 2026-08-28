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

export const DEFAULT_FG = '#dfe4ec'

const BASIC = [
  '#3a4356', // black
  '#e07b7b', // red
  '#5fd39a', // green
  '#e2b258', // yellow
  '#4d8dfb', // blue
  '#c98a5e', // magenta
  '#5ac8fa', // cyan
  '#dfe4ec' // white
]

const BRIGHT = [
  '#6d7686',
  '#f0a3a3',
  '#8ee6bb',
  '#eec685',
  '#7aa9fc',
  '#e3b892',
  '#7fdbff',
  '#ffffff'
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

function applySgr(sgr: Sgr, params: string): Sgr {
  const codes = params.split(';').map((p) => (p === '' ? 0 : parseInt(p, 10)))
  let next: Sgr = { ...sgr }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c === 0) next = {}
    else if (c === 1) next.bold = true
    else if (c === 2) next.dim = true
    else if (c === 22) {
      next.bold = false
      next.dim = false
    } else if (c >= 30 && c <= 37) next.color = BASIC[c - 30]
    else if (c >= 90 && c <= 97) next.color = BRIGHT[c - 90]
    else if (c === 39) next.color = undefined
    else if (c === 38 || c === 48) {
      const mode = codes[i + 1]
      const color =
        mode === 5
          ? xterm256(codes[i + 2] ?? 0)
          : mode === 2
            ? `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`
            : undefined
      i += mode === 5 ? 2 : mode === 2 ? 4 : 0
      if (c === 38 && color) next.color = color
    }
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

export function write(state: TermState, chunk: string): TermState {
  const buf = state.pending + chunk
  const rows = state.rows.slice()
  if (rows.length === 0) rows.push([])
  let cur = rows[rows.length - 1].map((c) => ({ ...c }))
  rows[rows.length - 1] = cur

  let sgr = state.sgr
  let col = state.col
  const indent = state.indent
  let alt = state.altScreen
  let pending = ''

  const note = (text: string): void => {
    if (cur.length) {
      cur = []
      rows.push(cur)
    }
    for (const ch of text) cur.push({ ch, color: '#7f889a' })
    cur = []
    rows.push(cur)
    col = 0
  }

  const newline = (): void => {
    cur = []
    rows.push(cur)
    col = 0
    for (const ch of indent) cur.push({ ch })
    col = indent.length
  }

  /** Write one character at the cursor, padding with blanks to reach it. */
  const put = (ch: string): void => {
    if (col >= MAX_COLS) return
    while (cur.length < col) cur.push({ ...BLANK })
    cur[col] = { ch, color: sgr.color, bold: sgr.bold, dim: sgr.dim }
    col++
  }

  let i = 0
  while (i < buf.length) {
    const ch = buf[i]

    if (ch === '\x1b') {
      const rest = buf.slice(i)
      const read = readEscape(rest)
      if (read === 'incomplete') {
        pending = rest
        break
      }
      if (read === null) {
        i += 1
        continue
      }
      const { kind, seq } = read
      i += seq.length
      if (kind !== 'csi') continue

      const final = seq[seq.length - 1]
      const body = seq.slice(2, -1)
      const priv = body.startsWith('?')
      const nums = (priv ? body.slice(1) : body).split(';').map((p) => parseInt(p, 10))
      const n = Number.isFinite(nums[0]) ? nums[0] : undefined

      if (priv) {
        // Alternate screen: the program is drawing a whole display.
        if (final === 'h' && (n === 1049 || n === 1047 || n === 47)) {
          if (!alt) {
            alt = true
            note('[full-screen program — output not shown in this pane]')
          }
        } else if (final === 'l' && (n === 1049 || n === 1047 || n === 47)) {
          alt = false
        }
        continue
      }
      if (alt) continue

      switch (final) {
        case 'm':
          sgr = applySgr(sgr, body)
          break
        case 'C': // cursor forward
          col = Math.min(MAX_COLS, col + Math.max(1, n ?? 1))
          break
        case 'D': // cursor back
          col = Math.max(0, col - Math.max(1, n ?? 1))
          break
        case 'G': // cursor to column
        case '`':
          col = Math.max(0, Math.min(MAX_COLS, (n ?? 1) - 1))
          break
        case 'H': // cursor position — only the column applies to a line buffer
        case 'f': {
          const c = Number.isFinite(nums[1]) ? nums[1] : 1
          col = Math.max(0, Math.min(MAX_COLS, c - 1))
          break
        }
        case 'K': // erase in line
          if (n === 1) for (let k = 0; k < col && k < cur.length; k++) cur[k] = { ...BLANK }
          else if (n === 2) cur.length = 0
          else cur.length = Math.min(cur.length, col)
          break
        case 'X': {
          // erase n characters
          const count = Math.max(1, n ?? 1)
          const end = Math.min(MAX_COLS, col + count)
          while (cur.length < end) cur.push({ ...BLANK })
          for (let k = col; k < end; k++) cur[k] = { ...BLANK }
          break
        }
        default:
          break
      }
      continue
    }

    if (alt) {
      // Swallow the program's redraw traffic, but keep line breaks out of it.
      i++
      continue
    }

    if (ch === '\n') {
      newline()
      i++
      continue
    }
    if (ch === '\r') {
      col = 0
      i++
      continue
    }
    if (ch === '\b') {
      col = Math.max(0, col - 1)
      i++
      continue
    }
    if (ch === '\t') {
      const target = Math.min(MAX_COLS, col + (8 - (col % 8)))
      while (col < target) put(' ')
      i++
      continue
    }
    if (ch < ' ' || ch === '\x7f') {
      i++
      continue
    }

    put(ch)
    i++
  }

  return { rows, sgr, pending, indent, col, altScreen: alt }
}

/** Write a whole styled line of BuildFlow's own text (run logs, echoes). */
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
