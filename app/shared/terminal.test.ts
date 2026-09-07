import { describe, expect, it } from 'vitest'
import { appendTail, plainText, stripAnsi } from './terminal'

describe('appendTail', () => {
  it('keeps only the trailing window', () => {
    expect(appendTail('abc', 'defgh', 4)).toBe('efgh')
    expect(appendTail('', 'hello', 3)).toBe('llo')
    expect(appendTail('hi', '!', 10)).toBe('hi!')
  })
})

describe('plainText', () => {
  it('drops ANSI colour and OSC sequences', () => {
    expect(plainText('\x1b[31merror\x1b[0m')).toBe('error')
    expect(stripAnsi('\x1b]0;title\x07x')).toBe('x')
  })

  it('collapses carriage-return overwrites to the final state', () => {
    expect(plainText('10%\r50%\r100%')).toBe('100%')
  })

  it("removes zsh's partial-line marker, which is the shell, not the command", () => {
    // zsh prints % padded to the terminal width, then a CR, when output has no
    // trailing newline — this is what leaked into agent-visible logs.
    expect(plainText('%' + ' '.repeat(109) + '\rerror: something is wrong')).toBe(
      'error: something is wrong'
    )
  })

  it('keeps a real percentage that happens to end a line', () => {
    expect(plainText('coverage: 92%\ndone')).toBe('coverage: 92%\ndone')
  })

  it('normalises CRLF and trims trailing padding', () => {
    expect(plainText('a   \r\nb\t\r\n')).toBe('a\nb\n')
  })
})
