import { describe, expect, it } from 'vitest'
import {
  clearIndent,
  emptyTerm,
  ensureNewline,
  MAX_COLS,
  rowText,
  segments,
  setIndent,
  trimTo,
  write,
  writeLine
} from './ansi'

const text = (t: { rows: { ch: string }[][] }): string[] => t.rows.map((r) => rowText(r))

describe('ansi', () => {
  it('keeps line content across CRLF', () => {
    const t = write(emptyTerm(), 'total 344\r\ndrwxr-xr-x 14 acf staff 448 .\r\n')
    expect(text(t)).toEqual(['total 344', 'drwxr-xr-x 14 acf staff 448 .', ''])
  })

  it('lets a bare CR redraw the line, as progress bars do', () => {
    const t = write(emptyTerm(), '10%\r50%\r100% done\r\nnext\r\n')
    expect(text(t)).toEqual(['100% done', 'next', ''])
  })

  it('carries a pending CR across chunk boundaries', () => {
    let t = write(emptyTerm(), 'first\r')
    t = write(t, 'second\r\n')
    expect(text(t)).toEqual(['second', ''])
  })

  it('applies SGR colour and resets it', () => {
    const t = write(emptyTerm(), '\x1b[32mgreen\x1b[0m plain')
    expect(segments(t.rows[0])).toEqual([
      { text: 'green', color: '#5fd39a', bold: undefined, dim: undefined },
      { text: ' plain', color: undefined, bold: undefined, dim: undefined }
    ])
  })

  it('supports 256-colour and truecolour', () => {
    expect(segments(write(emptyTerm(), '\x1b[38;5;196mred').rows[0])[0].color).toBe('rgb(255,0,0)')
    expect(segments(write(emptyTerm(), '\x1b[38;2;10;20;30mrgb').rows[0])[0].color).toBe(
      'rgb(10,20,30)'
    )
  })

  it('waits for a long escape split across chunks instead of printing it', () => {
    // The tail here is well over the old 12-character cutoff.
    let t = write(emptyTerm(), 'x\x1b[38;2;215;119')
    expect(text(t)).toEqual(['x'])
    t = write(t, ';87mcolour')
    expect(text(t)).toEqual(['xcolour'])
    expect(segments(t.rows[0])[1]).toMatchObject({ text: 'colour', color: 'rgb(215,119,87)' })
  })

  it('never leaks an escape sequence as literal text', () => {
    let t = emptyTerm()
    for (const ch of '\x1b[1;38;5;214mwarn\x1b[0m') t = write(t, ch) // one byte at a time
    expect(text(t)).toEqual(['warn'])
  })

  it('honours cursor-forward instead of running words together', () => {
    // "Tips" then jump 4 columns then "for" — a TUI's way of spacing.
    const t = write(emptyTerm(), 'Tips\x1b[4Cfor')
    expect(text(t)).toEqual(['Tips    for'])
  })

  it('places text at an absolute column', () => {
    const t = write(emptyTerm(), 'name\x1b[20Gvalue')
    expect(rowText(t.rows[0])).toBe('name' + ' '.repeat(15) + 'value')
  })

  it('overwrites in place after a cursor move back', () => {
    // Back 5 columns lands on "world", which the next 5 characters replace.
    const t = write(emptyTerm(), 'hello world\x1b[5Dthere')
    expect(text(t)).toEqual(['hello there'])
  })

  it('erases to end of line', () => {
    const t = write(emptyTerm(), 'keep this\x1b[5D\x1b[K')
    expect(text(t)).toEqual(['keep'])
  })

  it('reports a full-screen program instead of rendering its redraws', () => {
    let t = write(emptyTerm(), 'before\r\n\x1b[?1049h')
    t = write(t, '\x1b[2J\x1b[H┌───┐\r\n│ui │\r\n')
    expect(text(t)).toEqual(['before', '[full-screen program — output not shown in this pane]', ''])
    expect(t.altScreen).toBe(true)

    t = write(t, '\x1b[?1049lback to normal\r\n')
    expect(t.altScreen).toBe(false)
    expect(text(t)).toContain('back to normal')
  })

  it('drops cursor movement and window-title sequences', () => {
    const t = write(emptyTerm(), '\x1b]0;my title\x07\x1b[2Ahello')
    expect(text(t)).toEqual(['hello'])
  })

  it('expands tabs to the next stop and applies backspace', () => {
    const t = write(emptyTerm(), 'ab\tc\r\nback\x08\x08space')
    expect(text(t)).toEqual(['ab      c', 'baspace'])
  })

  it('indents new lines while a step is streaming', () => {
    let t = setIndent(emptyTerm(), '  ')
    t = write(t, 'one\r\ntwo\r\n')
    expect(text(t)).toEqual(['  one', '  two', '  '])
    t = clearIndent(t)
    expect(text(t)).toEqual(['  one', '  two', ''])
  })

  it('writes whole styled lines without leaving blank gaps', () => {
    let t = writeLine(emptyTerm(), 'first', { color: '#fff' })
    t = writeLine(t, 'second', { color: '#fff' })
    expect(text(t)).toEqual(['first', 'second', ''])
  })

  it('only breaks a line when there is something on it', () => {
    const t = ensureNewline(write(emptyTerm(), 'partial'))
    expect(text(t)).toEqual(['partial', ''])
    expect(text(ensureNewline(t))).toEqual(['partial', ''])
  })

  it('trims scrollback to the most recent lines', () => {
    let t = emptyTerm()
    t = write(t, Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\r\n'))
    t = trimTo(t, 10)
    expect(t.rows).toHaveLength(10)
    expect(text(t)[0]).toBe('line 40')
  })

  it('caps row length so a single dump cannot exhaust the heap', () => {
    const t = write(emptyTerm(), 'x'.repeat(MAX_COLS * 4))
    expect(t.rows[0].length).toBe(MAX_COLS)
    expect(t.col).toBe(MAX_COLS)
  })
})
