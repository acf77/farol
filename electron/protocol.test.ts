import { describe, expect, it } from 'vitest'
import { execScript, feedMarks, initScript, MARK_END, MARK_START, quoteSh } from './protocol'

describe('quoteSh', () => {
  it('wraps in single quotes and escapes inner ones', () => {
    expect(quoteSh('echo test')).toBe("'echo test'")
    expect(quoteSh("echo 'hi'")).toBe("'echo '\\''hi'\\'''")
  })
})

describe('initScript', () => {
  it('prints a ready marker instead of setting PROMPT', () => {
    const zsh = initScript('zsh')
    expect(zsh).toContain('__bf_run')
    expect(zsh).toContain("printf $'\\001BFL%s:%s\\002'")
    expect(zsh).not.toContain('PROMPT=$')
  })
})

describe('execScript', () => {
  it('calls the helper with a quoted command', () => {
    expect(execScript('zsh', 'echo "test"')).toBe("__bf_run 'echo \"test\"'\n")
  })
})

describe('feedMarks', () => {
  it('splits output from a completed command', () => {
    const chunk = `test\r\n${MARK_START}0:/repo${MARK_END}`
    const r = feedMarks(chunk)
    expect(r.text).toBe('test\r\n')
    expect(r.marks).toEqual([{ code: 0, cwd: '/repo' }])
    expect(r.rest).toBe('')
  })

  it('holds a partial marker across chunks', () => {
    const a = feedMarks('hello' + MARK_START.slice(0, 2))
    expect(a.text).toBe('hello')
    expect(a.rest).toBe(MARK_START.slice(0, 2))
    const b = feedMarks(a.rest + MARK_START.slice(2) + '1:/x' + MARK_END)
    expect(b.marks).toEqual([{ code: 1, cwd: '/x' }])
  })
})
