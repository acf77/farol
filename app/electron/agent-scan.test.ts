import { describe, expect, it } from 'vitest'
import { parseVersion } from './agent-scan'

describe('parseVersion', () => {
  it('pulls the version out of CLI banners', () => {
    expect(parseVersion('2.4.1 (Claude Code)\n')).toBe('2.4.1')
    expect(parseVersion('codex-cli 0.61.0')).toBe('0.61.0')
    expect(parseVersion('2025.10.2')).toBe('2025.10.2')
  })
  it('returns undefined when there is none', () => {
    expect(parseVersion('command not found')).toBeUndefined()
  })
})
