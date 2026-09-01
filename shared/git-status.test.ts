import { describe, expect, it } from 'vitest'
import { parseAheadBehind, parseGitStatus } from './git-status'

describe('parseGitStatus', () => {
  it('splits staged, unstaged, untracked, and conflicts', () => {
    const out = parseGitStatus(`M  staged.txt
 M unstaged.txt
?? new.txt
UU both.txt`)
    expect(out.staged.map((f) => f.path)).toEqual(['staged.txt'])
    expect(out.unstaged.map((f) => f.path)).toEqual(['unstaged.txt'])
    expect(out.untracked.map((f) => f.path)).toEqual(['new.txt'])
    expect(out.conflicts.map((f) => f.path)).toEqual(['both.txt'])
    expect(out.clean).toBe(false)
  })

  it('reports clean when porcelain is empty', () => {
    expect(parseGitStatus('').clean).toBe(true)
  })
})

describe('parseAheadBehind', () => {
  it('parses left-right counts', () => {
    expect(parseAheadBehind('2\t3')).toEqual({ behind: 2, ahead: 3 })
  })
})
