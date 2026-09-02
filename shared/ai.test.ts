import { describe, expect, it } from 'vitest'
import {
  aiCommand,
  aiSelectionLabel,
  isAiProvider,
  managedAiCommand,
  modelsFor,
  normalizeAi,
  normalizeModel,
  withModel
} from './ai'

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

describe('normalizeModel', () => {
  it('treats blank values as the CLI default', () => {
    expect(normalizeModel(undefined)).toBeUndefined()
    expect(normalizeModel('  ')).toBeUndefined()
    expect(normalizeModel('sonnet')).toBe('sonnet')
  })

  it('labels a stored id, including ones not in the catalog', () => {
    expect(aiSelectionLabel('claude', undefined)).toBe('Claude')
    expect(aiSelectionLabel('claude', 'sonnet')).toBe('Claude · Sonnet 5')
    expect(aiSelectionLabel('claude', 'custom-id')).toBe('Claude · custom-id')
    expect(modelsFor('claude', 'custom-id').some((m) => m.id === 'custom-id')).toBe(true)
  })
})

describe('withModel', () => {
  it('inserts --model before the trailing prompt', () => {
    expect(withModel(['-p', 'review this'], 'sonnet')).toEqual(['-p', '--model', 'sonnet', 'review this'])
    expect(withModel(['-p', 'review this'], undefined)).toEqual(['-p', 'review this'])
  })
})

describe('aiCommand', () => {
  it('builds a non-interactive argv for each provider', () => {
    expect(aiCommand('claude', 'review this').args).toEqual(['-p', 'review this'])
    expect(aiCommand('codex', 'review this').args).toEqual([
      'exec',
      '-c',
      'approval_policy=never',
      '--sandbox',
      'read-only',
      'review this'
    ])
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

  it('passes --model through to each CLI', () => {
    expect(aiCommand('claude', 'review this', 'sonnet').args).toEqual([
      '-p',
      '--model',
      'sonnet',
      'review this'
    ])
    expect(aiCommand('codex', 'review this', 'gpt-5.6-terra').args).toContain('--model')
    expect(aiCommand('cursor', 'review this', 'composer-2.5').args).toEqual([
      '-p',
      '--force',
      '--mode=ask',
      '--output-format',
      'text',
      '--model',
      'composer-2.5',
      'review this'
    ])
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
      '--json',
      '-c',
      'approval_policy=never',
      '--sandbox',
      'workspace-write',
      'fix this'
    ])
    expect(managedAiCommand('codex', 'fix this').args).not.toContain(
      'sandbox_workspace_write.network_access=true'
    )
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
    // Chat would sit blank; OpenCode narrates its progress as plain text.
    expect(managedAiCommand('claude', 'x').stream).toBe('ndjson')
    expect(managedAiCommand('cursor', 'x').stream).toBe('ndjson')
    expect(managedAiCommand('codex', 'x').stream).toBe('ndjson')
    expect(managedAiCommand('opencode', 'x').stream).toBeUndefined()
  })

  it('passes --model through on managed commands', () => {
    expect(managedAiCommand('claude', 'fix this', 'opus').args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      'opus',
      'fix this'
    ])
  })
})
