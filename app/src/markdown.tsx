import type { ReactNode } from 'react'
import { stripControlMarkerLines } from '@shared/control-line'
import { C, MONO } from './theme'

/**
 * Drop Farol harness markers so they do not clutter the chat once the
 * controller has already consumed them.
 */
export function stripControlMarkers(text: string): string {
  return stripControlMarkerLines(text).replace(/\n{3,}/g, '\n\n').trimEnd()
}

function inline(text: string, keyPrefix: string, depth = 0): ReactNode[] {
  if (depth > 24) return [text]
  const nodes: ReactNode[] = []
  // Inline code, bold, italic, links — processed left-to-right so nested
  // markers inside a code span stay literal. Code fences use equal-length
  // backtick runs so `` `a | b` `` works like GFM.
  const pattern = /(`+)((?:(?!\1).)+?)\1|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let match: RegExpExecArray | null
  let n = 0
  while ((match = pattern.exec(text))) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index))
    }
    const [full, , codeBody, bold, italic, link] = match
    const key = `${keyPrefix}-${n++}`
    if (codeBody !== undefined) {
      nodes.push(
        <code key={key} className="bf-md-code">
          {codeBody}
        </code>
      )
    } else if (bold) {
      nodes.push(
        <strong key={key} style={{ fontWeight: 600, color: '#F0F0EC' }}>
          {inline(bold.slice(2, -2), key, depth + 1)}
        </strong>
      )
    } else if (italic) {
      nodes.push(
        <em key={key} style={{ fontStyle: 'italic' }}>
          {inline(italic.slice(1, -1), key, depth + 1)}
        </em>
      )
    } else if (link) {
      const labelEnd = full.indexOf(']')
      const label = full.slice(1, labelEnd)
      const href = full.slice(labelEnd + 2, -1)
      if (/^https?:\/\//i.test(href)) {
        nodes.push(
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {label}
          </a>
        )
      } else {
        nodes.push(label)
      }
    }
    last = match.index + full.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function heading(level: number, text: string, key: string): ReactNode {
  const size = level === 1 ? 18 : level === 2 ? 15.5 : 13.5
  const weight = level <= 2 ? 600 : 500
  return (
    <div
      key={key}
      style={{
        fontSize: size,
        fontWeight: weight,
        letterSpacing: level === 1 ? '-0.2px' : undefined,
        color: '#F0F0EC',
        marginTop: level === 1 ? 4 : 2,
        marginBottom: 2
      }}
    >
      {inline(text, key)}
    </div>
  )
}

function codeBlock(body: string, lang: string | undefined, key: string): ReactNode {
  return (
    <pre
      key={key}
      style={{
        margin: '4px 0',
        padding: '12px 14px',
        background: '#181817',
        border: '1px solid #3E3E3A',
        borderRadius: 9,
        overflowX: 'auto',
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 1.5,
        color: '#C4C4BE'
      }}
    >
      {lang ? (
        <div style={{ fontSize: 10.5, color: C.faint, marginBottom: 8, userSelect: 'none' }}>{lang}</div>
      ) : null}
      <code style={{ fontFamily: 'inherit', whiteSpace: 'pre' }}>{body.replace(/\n$/, '')}</code>
    </pre>
  )
}

function listItem(text: string, ordered: boolean, index: number, key: string): ReactNode {
  return (
    <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <span
        style={{
          flex: 'none',
          minWidth: ordered ? 18 : 10,
          color: '#A1A19A',
          fontFamily: ordered ? MONO : 'inherit',
          fontSize: ordered ? 12 : 13.5,
          lineHeight: 1.6
        }}
      >
        {ordered ? `${index}.` : '•'}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{inline(text, key)}</span>
    </div>
  )
}

type BlockParse = { node: ReactNode; next: number }

type TableAlignment = 'left' | 'center' | 'right'

type TableScan = { cells: string[]; hasPipe: boolean }

/**
 * Split a GFM table row. Escaped pipes and pipes inside matching backtick
 * spans stay in the cell; opening/closing runs must be the same length.
 */
function scanTableLine(line: string): TableScan {
  const source = line.trim()
  const cells: string[] = []
  let cell = ''
  let hasPipe = false
  let codeFence = 0
  let i = 0

  while (i < source.length) {
    const char = source[i]
    if (char === '`') {
      let run = 0
      while (i + run < source.length && source[i + run] === '`') run++
      if (codeFence === 0) codeFence = run
      else if (run === codeFence) codeFence = 0
      cell += source.slice(i, i + run)
      i += run
      continue
    }
    if (char === '\\' && codeFence === 0 && source[i + 1] === '|') {
      cell += '|'
      i += 2
      continue
    }
    if (char === '|' && codeFence === 0) {
      hasPipe = true
      cells.push(cell.trim())
      cell = ''
      i++
      continue
    }
    cell += char
    i++
  }

  cells.push(cell.trim())
  if (source.startsWith('|') && cells[0] === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
  return { cells, hasPipe }
}

function tableCells(line: string): string[] {
  return scanTableLine(line).cells
}

function hasTablePipe(line: string): boolean {
  return scanTableLine(line).hasPipe
}

/**
 * Other markdown blocks must not be swallowed as table body rows.
 * Patterns match the block parsers (column 0 only) — do not trim, or indented
 * markers interrupt paragraphs without being parsed and stall the renderer.
 */
function isBlockInterrupt(line: string): boolean {
  return (
    /^```/.test(line) ||
    /^#{1,3}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^[-*+]\s+/.test(line) ||
    /^\d+\.\s+/.test(line) ||
    /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
  )
}

function isTableBodyRow(line: string): boolean {
  return !!line.trim() && !isBlockInterrupt(line) && hasTablePipe(line)
}

function tableDelimiter(line: string): TableAlignment[] | null {
  if (!hasTablePipe(line)) return null
  const cells = tableCells(line)
  if (!cells.length || cells.some((cell) => !/^:?-{3,}:?$/.test(cell))) return null
  return cells.map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    // GFM default (no colons) is left — always emit so UA-centered <th> cannot win.
    return left && right ? 'center' : right ? 'right' : 'left'
  })
}

function isTableStart(lines: string[], i: number): boolean {
  if (i + 1 >= lines.length || !hasTablePipe(lines[i]) || isBlockInterrupt(lines[i])) return false
  const alignments = tableDelimiter(lines[i + 1])
  return !!alignments && tableCells(lines[i]).length === alignments.length
}

function parseTable(lines: string[], i: number, key: string): BlockParse | null {
  if (!isTableStart(lines, i)) return null
  const headers = tableCells(lines[i])
  const alignments = tableDelimiter(lines[i + 1])!
  const rows: string[][] = []
  let j = i + 2

  while (j < lines.length && isTableBodyRow(lines[j])) {
    const cells = tableCells(lines[j]).slice(0, headers.length)
    while (cells.length < headers.length) cells.push('')
    rows.push(cells)
    j++
  }

  return {
    node: (
      <div key={key} className="bf-md-table-wrap">
        <table className="bf-md-table">
          <thead>
            <tr>
              {headers.map((cell, column) => (
                <th key={`${key}-h${column}`} scope="col" style={{ textAlign: alignments[column] }}>
                  {inline(cell, `${key}-h${column}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`${key}-r${rowIndex}`}>
                {row.map((cell, column) => (
                  <td key={`${key}-r${rowIndex}c${column}`} style={{ textAlign: alignments[column] }}>
                    {inline(cell, `${key}-r${rowIndex}c${column}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
    next: j
  }
}

function parseFence(lines: string[], i: number, key: string): BlockParse | null {
  const fence = /^```([\w-]*)\s*$/.exec(lines[i])
  if (!fence) return null
  const lang = fence[1] || undefined
  const body: string[] = []
  let j = i + 1
  while (j < lines.length && !/^```\s*$/.test(lines[j])) {
    body.push(lines[j])
    j++
  }
  if (j < lines.length) j++ // closing fence
  return { node: codeBlock(body.join('\n'), lang, key), next: j }
}

function parseHeading(line: string, key: string, next: number): BlockParse | null {
  const head = /^(#{1,3})\s+(.+)$/.exec(line)
  if (!head) return null
  return { node: heading(head[1].length, head[2].trim(), key), next }
}

function parseHr(line: string, key: string, next: number): BlockParse | null {
  if (!/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return null
  return {
    node: (
      <hr key={key} style={{ border: 'none', borderTop: '1px solid #3E3E3A', margin: '10px 0' }} />
    ),
    next
  }
}

function parseQuote(lines: string[], i: number, key: string): BlockParse | null {
  if (!/^>\s?/.test(lines[i])) return null
  const quote: string[] = []
  let j = i
  while (j < lines.length && /^>\s?/.test(lines[j])) {
    quote.push(lines[j].replace(/^>\s?/, ''))
    j++
  }
  return {
    node: (
      <div
        key={key}
        style={{
          borderLeft: '2px solid #3E3E3A',
          paddingLeft: 12,
          color: '#A1A19A',
          display: 'flex',
          flexDirection: 'column',
          gap: 4
        }}
      >
        {quote.map((q, qi) => (
          <div key={`${key}-q${qi}`}>{inline(q, `${key}-q${qi}`) || '\u00a0'}</div>
        ))}
      </div>
    ),
    next: j
  }
}

function parseList(
  lines: string[],
  i: number,
  key: string,
  pattern: RegExp,
  strip: RegExp,
  ordered: boolean
): BlockParse | null {
  if (!pattern.test(lines[i])) return null
  const items: string[] = []
  let j = i
  while (j < lines.length && pattern.test(lines[j])) {
    items.push(lines[j].replace(strip, ''))
    j++
  }
  return {
    node: (
      <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {items.map((item, ii) => listItem(item, ordered, ii + 1, `${key}-i${ii}`))}
      </div>
    ),
    next: j
  }
}

/** True while a paragraph should keep absorbing the line. */
function continuesParagraph(line: string): boolean {
  return !!line.trim() && !isBlockInterrupt(line)
}

function parseParagraph(lines: string[], i: number, key: string): BlockParse {
  const para: string[] = []
  let j = i
  while (j < lines.length && continuesParagraph(lines[j]) && !isTableStart(lines, j)) {
    para.push(lines[j])
    j++
  }
  return {
    node: (
      <div key={key} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {inline(para.join('\n'), key)}
      </div>
    ),
    next: j
  }
}

/**
 * Render a subset of Markdown that coding agents commonly emit: headings,
 * fenced code, tables, lists, quotes, rules, and inline emphasis/links/code.
 */
export function renderMarkdown(source: string): ReactNode[] {
  const text = stripControlMarkers(source)
  const lines = text.split(/\r?\n/)
  const nodes: ReactNode[] = []
  let i = 0
  let block = 0

  while (i < lines.length) {
    const line = lines[i]
    const key = `b${block++}`

    const parsed =
      parseFence(lines, i, key) ??
      parseTable(lines, i, key) ??
      parseHeading(line, key, i + 1) ??
      parseHr(line, key, i + 1) ??
      parseQuote(lines, i, key) ??
      parseList(lines, i, key, /^[-*+]\s+/, /^[-*+]\s+/, false) ??
      parseList(lines, i, key, /^\d+\.\s+/, /^\d+\.\s+/, true)

    if (parsed) {
      nodes.push(parsed.node)
      i = parsed.next
      continue
    }

    // Blank line → spacing only when content follows
    if (!line.trim()) {
      i++
      continue
    }

    const para = parseParagraph(lines, i, key)
    nodes.push(para.node)
    // Never stall: if nothing absorbed the line, skip it (defensive).
    i = para.next > i ? para.next : i + 1
  }

  return nodes
}

export function MarkdownBody({ text }: { text: string }) {
  let body: ReactNode
  try {
    body = renderMarkdown(typeof text === 'string' ? text : String(text ?? ''))
  } catch (error) {
    console.error('[farol] markdown render failed', error)
    body = typeof text === 'string' ? text : String(text ?? '')
  }
  return (
    <div
      className="bf-md"
      style={{
        fontSize: 13.5,
        lineHeight: 1.6,
        color: '#F0F0EC',
        textWrap: 'pretty',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        userSelect: 'text'
      }}
    >
      {body}
    </div>
  )
}
