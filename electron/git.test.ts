import { describe, expect, it } from 'vitest'
import { sanitizeCommitMessage } from './git'

describe('sanitizeCommitMessage', () => {
  it('strips markdown fences and blank lines', () => {
    expect(sanitizeCommitMessage('```\nfeat: add git panel\n```')).toBe('feat: add git panel')
  })

  it('keeps at most twelve non-empty lines', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n')
    expect(sanitizeCommitMessage(lines).split('\n')).toHaveLength(12)
  })

  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeCommitMessage('   \n\n  ')).toBe('')
  })
})
