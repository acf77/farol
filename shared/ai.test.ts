import { describe, expect, it } from 'vitest'
import { aiCommand, isAiProvider, managedAiCommand, normalizeAi } from './ai'

describe('normalizeAi', () => {
  it('keeps a known provider', () => {
    expect(normalizeAi('codex')).toBe('codex')
    expect(normalizeAi('cursor')).toBe('cursor')
    expect(normalizeAi('opencode')).toBe('opencode')
    expect(normalizeAi('claude')).toBe('claude')
  })

  it('falls back to Claude for missing or unknown values', () => {
    expect(normalizeAi(undefined)).toBe('claude')
    expect(normalizeAi('gpt')).toBe('claude')
    expect(isAiProvider('agent')).toBe(false)
  })
})

describe('aiCommand', () => {
  it('builds a non-interactive argv for each provider', () => {
    expect(aiCommand('claude', 'review this').args).toEqual(['-p', 'review this'])
    expect(aiCommand('codex', 'review this').args).toEqual(['exec', 'review this'])
    expect(aiCommand('cursor', 'review this').args).toEqual([
      '-p',
      '--force',
      '--mode=ask',
      '--output-format',
      'text',
      'review this'
    ])
    expect(aiCommand('opencode', 'review this').args).toEqual(['run', '--auto', 'review this'])
  })

  it('tries Cursor as agent, then cursor-agent', () => {
    expect(aiCommand('cursor', 'x').bins).toEqual(['agent', 'cursor-agent'])
  })
})

describe('managedAiCommand', () => {
  it('auto-approves every provider so headless Chat can use shell tools', () => {
    expect(managedAiCommand('claude', 'fix this').args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      'fix this'
    ])
    expect(managedAiCommand('codex', 'fix this').args).toEqual([
      'exec',
      '--full-auto',
      'fix this'
    ])
    expect(managedAiCommand('cursor', 'fix this').args).toEqual([
      '-p',
      '--force',
      '--output-format',
      'stream-json',
      'fix this'
    ])
    expect(managedAiCommand('opencode', 'fix this').args).toEqual([
      'run',
      '--dangerously-skip-permissions',
      'fix this'
    ])
  })

  it('marks the providers whose stdout has to be decoded as NDJSON', () => {
    // Claude and Cursor print nothing under `text` until the run ends, so
    // Chat would sit blank; the other two narrate their progress as they go.
    expect(managedAiCommand('claude', 'x').stream).toBe('ndjson')
    expect(managedAiCommand('cursor', 'x').stream).toBe('ndjson')
    expect(managedAiCommand('codex', 'x').stream).toBeUndefined()
    expect(managedAiCommand('opencode', 'x').stream).toBeUndefined()
  })
})
