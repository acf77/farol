import type { ReactNode } from 'react'
import { C, MONO } from './theme'

/** Control lines the managed harness reads — hide them from the transcript. */
const CONTROL_LINE = /^\s*FAROL_(?:PIPELINES|BLOCKED):.*$/

/**
 * Drop Farol harness markers so they do not clutter the chat once the
 * controller has already consumed them.
 */
export function stripControlMarkers(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !CONTROL_LINE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

function inline(text: string, keyPrefix: string, depth = 0): ReactNode[] {
  if (depth > 24) return [text]
  const nodes: ReactNode[] = []
  // Inline code, bold, italic, links — processed left-to-right so nested
  // markers inside a code span stay literal.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let match: RegExpExecArray | null
  let n = 0
  while ((match = pattern.exec(text))) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index))
    }
    const [full, code, bold, italic, link] = match
    const key = `${keyPrefix}-${n++}`
    if (code) {
      nodes.push(
        <code key={key} className="bf-md-code">
          {code.slice(1, -1)}
        </code>
      )
    } else if (bold) {
      nodes.push(
        <strong key={key} style={{ fontWeight: 600, color: '#F8FAFC' }}>
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
        color: '#F8FAFC',
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
        background: '#080D17',
        border: '1px solid #273449',
        borderRadius: 9,
        overflowX: 'auto',
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 1.5,
        color: '#CBD5E1'
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
          color: '#94A3B8',
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
      <hr key={key} style={{ border: 'none', borderTop: '1px solid #273449', margin: '10px 0' }} />
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
          borderLeft: '2px solid #273449',
          paddingLeft: 12,
          color: '#94A3B8',
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
  return (
    !!line.trim() &&
    !/^```/.test(line) &&
    !/^#{1,3}\s+/.test(line) &&
    !/^>\s?/.test(line) &&
    !/^[-*+]\s+/.test(line) &&
    !/^\d+\.\s+/.test(line) &&
    !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
  )
}

function parseParagraph(lines: string[], i: number, key: string): BlockParse {
  const para: string[] = []
  let j = i
  while (j < lines.length && continuesParagraph(lines[j])) {
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
 * fenced code, lists, quotes, rules, and inline emphasis/links/code.
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
    i = para.next
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
        color: '#F8FAFC',
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
