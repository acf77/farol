import { useLayoutEffect, useRef, useState } from 'react'
import { MONO } from '../theme'
import { DEFAULT_FG, segments } from '../ansi'
import type { TermState } from '../ansi'
import ScrollToLatest from './ScrollToLatest'

/**
 * A pipeline run's log. Unlike a shell pane this is Farol's own output —
 * step headings, results and the captured output of each step — so it keeps
 * the line-based rendering the design specifies.
 */
export default function LogPane({ term }: { term: TermState }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [canJump, setCanJump] = useState(false)

  const sync = (el: HTMLDivElement): void => {
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stick.current = fromBottom < 90
    setCanJump(fromBottom > 24)
  }

  // Follow the tail unless the user has scrolled up to read something.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (stick.current) el.scrollTop = el.scrollHeight
    sync(el)
  }, [term.rows])

  return (
    <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      <div
        ref={scrollRef}
        onScroll={(e) => sync(e.currentTarget)}
        style={{ height: '100%', overflowY: 'auto', boxSizing: 'border-box', padding: '14px 16px 18px',
          fontFamily: MONO, fontSize: 12, lineHeight: 1.6, cursor: 'text', userSelect: 'text' }}
      >
        {Array.isArray(term.rows)
          ? term.rows.map((row, i) => (
            <div
              key={i}
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                minHeight: 20,
                color: DEFAULT_FG
              }}
            >
              {Array.isArray(row)
                ? segments(row).map((s, j) => (
                    <span
                      key={j}
                      style={{
                        color: s.color,
                        fontWeight: s.bold ? 600 : 400,
                        opacity: s.dim ? 0.65 : 1
                      }}
                    >
                      {s.text}
                    </span>
                  ))
                : null}
            </div>
            ))
          : null}
      </div>
      <ScrollToLatest visible={canJump} onClick={() => {
        const el = scrollRef.current
        if (!el) return
        stick.current = true
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      }} />
    </div>
  )
}
