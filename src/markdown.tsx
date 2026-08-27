import type { ReactNode } from 'react'
import { C, MONO } from './theme'

/** Control lines the managed harness reads — hide them from the transcript. */
const CONTROL_LINE = /^\s*BUILDFLOW_(?:PIPELINES|BLOCKED):.*$/

/**
 * Drop BuildFlow harness markers so they do not clutter the chat once the
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

function inline(text: string, keyPrefix: string): ReactNode[] {
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
        <strong key={key} style={{ fontWeight: 600, color: '#eef1f6' }}>
          {inline(bold.slice(2, -2), key)}
        </strong>
      )
    } else if (italic) {
      nodes.push(
        <em key={key} style={{ fontStyle: 'italic' }}>
          {inline(italic.slice(1, -1), key)}
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
        color: '#eef1f6',
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
        background: '#0e131b',
        border: '1px solid #212938',
        borderRadius: 9,
        overflowX: 'auto',
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 1.5,
        color: '#c3cad6'
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
          color: '#7f889a',
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

    // Fenced code block
    const fence = /^```([\w-]*)\s*$/.exec(line)
    if (fence) {
      const lang = fence[1] || undefined
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // closing fence
      nodes.push(codeBlock(body.join('\n'), lang, key))
      continue
    }

    // Headings
    const head = /^(#{1,3})\s+(.+)$/.exec(line)
    if (head) {
      nodes.push(heading(head[1].length, head[2].trim(), key))
      i++
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      nodes.push(
        <hr
          key={key}
          style={{ border: 'none', borderTop: '1px solid #242c3b', margin: '10px 0' }}
        />
      )
      i++
      continue
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      nodes.push(
        <div
          key={key}
          style={{
            borderLeft: '2px solid #3a4558',
            paddingLeft: 12,
            color: '#9aa3b2',
            display: 'flex',
            flexDirection: 'column',
            gap: 4
          }}
        >
          {quote.map((q, qi) => (
            <div key={`${key}-q${qi}`}>{inline(q, `${key}-q${qi}`) || '\u00a0'}</div>
          ))}
        </div>
      )
      continue
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s+/, ''))
        i++
      }
      nodes.push(
        <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {items.map((item, ii) => listItem(item, false, ii + 1, `${key}-i${ii}`))}
        </div>
      )
      continue
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''))
        i++
      }
      nodes.push(
        <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {items.map((item, ii) => listItem(item, true, ii + 1, `${key}-i${ii}`))}
        </div>
      )
      continue
    }

    // Blank line → spacing only when content follows
    if (!line.trim()) {
      i++
      continue
    }

    // Paragraph: gather consecutive plain lines
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^[-*+]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    nodes.push(
      <div key={key} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {inline(para.join('\n'), key)}
      </div>
    )
  }

  return nodes
}

export function MarkdownBody({ text }: { text: string }) {
  return (
    <div
      className="bf-md"
      style={{
        fontSize: 13.5,
        lineHeight: 1.6,
        color: '#dfe4ec',
        textWrap: 'pretty',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        userSelect: 'text'
      }}
    >
      {renderMarkdown(text)}
    </div>
  )
}
