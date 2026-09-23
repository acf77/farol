import { describe, expect, it } from 'vitest'
import {
  AI_PROVIDERS,
  aiCommand,
  aiFixCommand,
  aiSelectionLabel,
  cliFor,
  interactiveAiCommand,
  hasReviewGate,
  isAiProvider,
  isUnknownJsonFormatError,
  managedAiCommand,
  modelsFor,
  normalizeAi,
  normalizeModel,
  pickerProviders,
  providerModels,
  usesOpenRouterEnv,
  withModel
} from './ai'

describe('normalizeAi', () => {
  it('keeps a known provider', () => {
    expect(normalizeAi('codex')).toBe('codex')
    expect(normalizeAi('cursor')).toBe('cursor')
    expect(normalizeAi('opencode')).toBe('opencode')
    expect(normalizeAi('openrouter')).toBe('openrouter')
    expect(normalizeAi('claude')).toBe('claude')
  })

  it('falls back to Claude for missing or unknown values', () => {
    expect(normalizeAi(undefined)).toBe('claude')
    expect(normalizeAi('gpt')).toBe('claude')
    expect(isAiProvider('agent')).toBe(false)
  })
})

describe('review gates', () => {
  it('exposes Plan only where managed Chat can enforce read-only access', () => {
    expect(hasReviewGate('codex')).toBe(true)
    expect(hasReviewGate('cursor')).toBe(true)
    expect(hasReviewGate('omp')).toBe(true)
    expect(hasReviewGate('claude')).toBe(false)
    expect(hasReviewGate('opencode')).toBe(false)
    expect(hasReviewGate('openrouter')).toBe(false)
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
    expect(aiSelectionLabel('cursor', undefined)).toBe('Cursor · Auto')
    expect(aiSelectionLabel('cursor', 'auto')).toBe('Cursor · Auto')
    expect(modelsFor('claude', 'custom-id').some((m) => m.id === 'custom-id')).toBe(true)
    expect(aiSelectionLabel('openrouter', undefined)).toBe('OpenRouter')
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
    expect(aiCommand('openrouter', 'review this').args).toEqual(['run', '--auto', 'review this'])
    // omp has no read-only sandbox flag, so the tool set enforces it.
    expect(aiCommand('omp', 'review this').args).toEqual([
      '-p',
      '--auto-approve',
      '--tools',
      'read,glob,grep,lsp',
      'review this'
    ])
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
    expect(aiCommand('cursor', 'review this', 'auto').args).toEqual([
      '-p',
      '--force',
      '--mode=ask',
      '--output-format',
      'text',
      '--model',
      'auto',
      'review this'
    ])
  })

  it('tries Cursor as agent, then cursor-agent', () => {
    expect(aiCommand('cursor', 'x').bins).toEqual(['agent', 'cursor-agent'])
  })
})

describe('managedAiCommand', () => {
  it('uses each provider review gate for Plan mode', () => {
    expect(managedAiCommand('codex', 'plan this', undefined, { mode: 'plan' }).args).toContain('read-only')
    expect(managedAiCommand('cursor', 'plan this', undefined, { mode: 'plan' }).args).toContain('--mode=ask')
    expect(managedAiCommand('omp', 'plan this', undefined, { mode: 'plan' }).args).toContain('read,glob,grep,lsp')
  })

  it('auto-approves every provider so headless Chat can use shell tools', () => {
    expect(managedAiCommand('claude', 'fix this').args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--strict-mcp-config',
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
      '--format',
      'json',
      '--dangerously-skip-permissions',
      'fix this'
    ])
    expect(managedAiCommand('openrouter', 'fix this').args).toEqual([
      'run',
      '--format',
      'json',
      '--dangerously-skip-permissions',
      'fix this'
    ])
    expect(managedAiCommand('omp', 'fix this').args).toEqual([
      '--mode',
      'json',
      '--auto-approve',
      'fix this'
    ])
  })

  it('passes a native --tools allowlist for Claude and OMP when supplied', () => {
    expect(
      managedAiCommand('claude', 'fix this', undefined, {
        tools: ['Read', 'Glob', 'Grep', 'AskUserQuestion', 'Edit']
      }).args
    ).toContain('--tools')
    expect(
      managedAiCommand('claude', 'fix this', undefined, {
        tools: ['Read', 'Edit']
      }).args
    ).toContain('Read,Edit')
    expect(
      managedAiCommand('omp', 'fix this', undefined, {
        tools: ['read', 'glob', 'grep', 'lsp', 'edit']
      }).args
    ).toEqual(['--mode', 'json', '--auto-approve', '--tools', 'read,glob,grep,lsp,edit', 'fix this'])
    // Prompt-only providers ignore the allowlist in argv.
    expect(
      managedAiCommand('cursor', 'fix this', undefined, { tools: ['Read', 'Edit'] }).args
    ).not.toContain('--tools')
  })

  it('marks the providers whose stdout has to be decoded as NDJSON', () => {
    // Claude and Cursor print nothing under `text` until the run ends, so
    // Chat would sit blank; OpenCode's default format is formatted prose.
    expect(managedAiCommand('claude', 'x').stream).toBe('ndjson')
    expect(managedAiCommand('cursor', 'x').stream).toBe('ndjson')
    expect(managedAiCommand('codex', 'x').stream).toBe('ndjson')
    expect(managedAiCommand('opencode', 'x').stream).toBe('ndjson')
    expect(managedAiCommand('openrouter', 'x').stream).toBe('ndjson')
    expect(managedAiCommand('omp', 'x').stream).toBe('ndjson')
    expect(managedAiCommand('opencode', 'x', undefined, { jsonFormat: false }).stream).toBeUndefined()
    expect(managedAiCommand('opencode', 'x', undefined, { jsonFormat: false }).args).toEqual([
      'run',
      '--dangerously-skip-permissions',
      'x'
    ])
  })

  it('detects older OpenCode builds that reject --format json', () => {
    expect(isUnknownJsonFormatError('error: unknown option --format')).toBe(true)
    expect(isUnknownJsonFormatError('Unknown flag: --format')).toBe(true)
    expect(isUnknownJsonFormatError('command failed')).toBe(false)
  })

  it('runs OpenRouter through OpenCode with a prefixed --model', () => {
    expect(cliFor('openrouter')).toBe('opencode')
    expect(usesOpenRouterEnv('openrouter')).toBe(true)
    expect(usesOpenRouterEnv('opencode')).toBe(true)
    expect(usesOpenRouterEnv('claude')).toBe(false)
    expect(aiCommand('openrouter', 'review this', 'anthropic/claude-sonnet-4').args).toEqual([
      'run',
      '--auto',
      '--model',
      'openrouter/anthropic/claude-sonnet-4',
      'review this'
    ])
    expect(managedAiCommand('openrouter', 'fix this', 'openai/gpt-4o').args).toEqual([
      'run',
      '--format',
      'json',
      '--dangerously-skip-permissions',
      '--model',
      'openrouter/openai/gpt-4o',
      'fix this'
    ])
    expect(interactiveAiCommand('openrouter')).toBe('opencode')
  })

  it('shows OpenRouter after a key and catalog exist, listing only its pins', () => {
    expect(pickerProviders().includes('openrouter')).toBe(false)
    expect(pickerProviders({ hasKey: true, pinned: [] }).includes('openrouter')).toBe(false)
    expect(pickerProviders({ hasKey: true, pinned: ['openai/gpt-4o'] }).includes('openrouter')).toBe(
      true
    )
    expect(
      pickerProviders({ hasKey: true, pinned: [], catalog: [{ id: 'openai/gpt-4o', label: 'GPT-4o' }] })
    ).toContain('openrouter')
    const catalog = [
      { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
      { id: 'openai/gpt-4o', label: 'GPT-4o' }
    ]
    expect(
      providerModels('openrouter', undefined, {
        openrouter: { pinned: ['openai/gpt-4o'], catalog }
      }).map((model) => model.id)
    ).toEqual(['openai/gpt-4o'])
    // Nothing pinned yet — the whole catalog, so the menu is never empty.
    expect(
      providerModels('openrouter', undefined, { openrouter: { pinned: [], catalog } }).map(
        (model) => model.id
      )
    ).toEqual(['anthropic/claude-sonnet-4', 'openai/gpt-4o'])
    // An unpinned id already in use stays selectable.
    expect(
      providerModels('openrouter', 'anthropic/claude-sonnet-4', {
        openrouter: { pinned: ['openai/gpt-4o'], catalog }
      }).map((model) => model.id)
    ).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
  })

  it('prefers a discovered catalog over the built-in fallback list', () => {
    expect(
      providerModels('codex', undefined, {
        catalogs: { codex: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }] }
      }).map((m) => m.id)
    ).toEqual(['gpt-6-astra'])
  })

  it('passes --model through on managed commands', () => {
    expect(managedAiCommand('claude', 'fix this', 'opus').args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--strict-mcp-config',
      '--model',
      'opus',
      'fix this'
    ])
  })
})

describe('omp', () => {
  it('is its own CLI, offered in the picker without any extra setup', () => {
    expect(cliFor('omp')).toBe('omp')
    expect(usesOpenRouterEnv('omp')).toBe(false)
    expect(pickerProviders()).toContain('omp')
    expect(AI_PROVIDERS).toContain('omp')
  })

  it('takes the prompt directly, interactively and headless', () => {
    expect(interactiveAiCommand('omp')).toBe('omp')
    expect(aiFixCommand('omp', 'REPORT.md')).toContain('omp "')
    expect(managedAiCommand('omp', 'fix this', 'gpt-5.6-terra').args).toEqual([
      '--mode',
      'json',
      '--auto-approve',
      '--model',
      'gpt-5.6-terra',
      'fix this'
    ])
  })
})
