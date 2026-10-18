import { describe, expect, it } from 'vitest'
import {
  parseAnthropicModels,
  parseOpenRouterClaudeAliases,
  filterModels,
  groupModels,
  mergeCatalogs,
  finalizeClaudeCatalog,
  parseClaudeHelp,
  parseClaudeModelOptions,
  parseCodexModelsCache,
  parseCursorModels,
  parseOmpModelsJson,
  parseOpenCodeModels,
  uniqueModels
} from './agent-models'

describe('parseCursorModels', () => {
  it('reads id and label from agent --list-models output', () => {
    const text = `Available models

auto - Auto (current, default)
composer-2.5 - Composer 2.5
gpt-5.6-sol-high - GPT-5.6 Sol 1M High
`
    expect(parseCursorModels(text)).toEqual([
      { id: 'auto', label: 'Auto' },
      { id: 'composer-2.5', label: 'Composer 2.5' },
      { id: 'gpt-5.6-sol-high', label: 'GPT-5.6 Sol 1M High' }
    ])
  })
})

describe('parseOpenCodeModels', () => {
  it('keeps provider/model ids and labels the model slug', () => {
    expect(parseOpenCodeModels('anthropic/claude-sonnet-5\nopenai/gpt-5.6\n')).toEqual([
      { id: 'anthropic/claude-sonnet-5', label: 'claude-sonnet-5' },
      { id: 'openai/gpt-5.6', label: 'gpt-5.6' }
    ])
  })

  it('skips blank and multi-word noise lines', () => {
    expect(parseOpenCodeModels('Error: missing auth\nok/one\n')).toEqual([
      { id: 'ok/one', label: 'one' }
    ])
  })
})

describe('parseClaudeHelp', () => {
  it('reads quoted --model aliases from claude --help', () => {
    const text = `  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name
`
    expect(parseClaudeHelp(text)).toEqual([
      { id: 'fable', label: 'Fable 5.1' },
      { id: 'opus', label: 'Opus 5.5' },
      { id: 'sonnet', label: 'Sonnet 5.5' },
      { id: 'claude-fable-5', label: 'claude-fable-5' }
    ])
  })
})

describe('parseAnthropicModels', () => {
  it('maps the newest active model of each line to its alias with its window', () => {
    expect(
      parseAnthropicModels({
        data: [
          { id: 'claude-sonnet-5-5', line: 'sonnet', display_name: 'Claude Sonnet 5.5', max_input_tokens: 1_000_000 },
          { id: 'claude-haiku-5-5', line: 'haiku', display_name: 'Claude Haiku 5.5', max_input_tokens: 200_000 },
          { id: 'claude-sonnet-5', line: 'sonnet', display_name: 'Claude Sonnet 5', max_input_tokens: 200_000 },
          { id: 'claude-opus-4', line: 'opus', display_name: 'Claude Opus 4', lifecycle: 'retired' }
        ]
      })
    ).toEqual([
      { id: 'sonnet', label: 'Sonnet 5.5', contextWindow: 1_000_000 },
      { id: 'haiku', label: 'Haiku 5.5', contextWindow: 200_000 }
    ])
  })
})

describe('parseOpenRouterClaudeAliases', () => {
  it('compares version parts as integers and skips variants', () => {
    const row = (id: string, w: number) => ({ id, name: `Anthropic: ${id}`, context_length: w })
    expect(
      parseOpenRouterClaudeAliases({
        data: [row('anthropic/claude-sonnet-5.9', 1), row('anthropic/claude-sonnet-5.10', 2), row('anthropic/claude-sonnet-6:thinking', 3), row('anthropic/claude-sonnet-5-20260901', 4), row('anthropic/claude-sonnet-6-beta', 5), row('anthropic/claude-sonnet-5.10-20260901', 6)]
      })
    ).toMatchObject([{ id: 'sonnet', contextWindow: 2 }])
  })

  it('uses the newest anthropic row per line', () => {
    expect(
      parseOpenRouterClaudeAliases({
        data: [
          { id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5', created: 1, context_length: 200_000 },
          { id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', created: 2, context_length: 1_000_000 },
          { id: 'openai/gpt-5.6', name: 'GPT', created: 3, context_length: 9 }
        ]
      })
    ).toEqual([{ id: 'sonnet', label: 'Sonnet 5.5', contextWindow: 1_000_000 }])
  })
})

describe('parseClaudeModelOptions', () => {
  it('keeps enabled cache rows and drops disabled update stubs', () => {
    expect(
      parseClaudeModelOptions([
        { value: 'claude-fable-5[1m]', label: 'Fable' },
        { value: 'cc-update-required-1', label: 'Fable 5.1 (disabled)', disabled: true }
      ])
    ).toEqual([{ id: 'claude-fable-5[1m]', label: 'Fable' }])
  })

  it('prefers Farol alias labels over stale Claude cache strings', () => {
    expect(parseClaudeModelOptions([{ value: 'opus', label: 'Opus 5' }])).toEqual([
      { id: 'opus', label: 'Opus 5.5' }
    ])
  })
})

describe('finalizeClaudeCatalog', () => {
  it('relabels known aliases when refreshing a persisted catalog', () => {
    expect(finalizeClaudeCatalog([{ id: 'opus', label: 'Opus 5' }])).toEqual([
      { id: 'opus', label: 'Opus 5.5' }
    ])
  })
})

describe('parseCodexModelsCache', () => {
  it('keeps list-visible models and drops hide', () => {
    expect(
      parseCodexModelsCache({
        models: [
          {
            slug: 'gpt-6-astra',
            display_name: 'GPT-6-Astra',
            visibility: 'list',
            supported_in_api: true
          },
          {
            slug: 'gpt-reserve',
            display_name: 'GPT-Reserve',
            visibility: 'hide',
            supported_in_api: true
          },
          {
            slug: 'legacy',
            display_name: 'Legacy',
            visibility: 'list',
            supported_in_api: false
          },
          {
            slug: 'gpt-6-listed',
            display_name: 'GPT-6-Listed',
            visibility: 'list'
          }
        ]
      })
    ).toEqual([
      { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
      { id: 'gpt-6-listed', label: 'GPT-6-Listed' }
    ])
  })
})

describe('parseOmpModelsJson', () => {
  it('uses short ids when unique and selectors when duplicated', () => {
    expect(
      parseOmpModelsJson({
        models: [
          { provider: 'cursor', id: 'composer-2.5', selector: 'cursor/composer-2.5', name: 'Composer 2.5' },
          { provider: 'cursor', id: 'gpt-5.6-sol', selector: 'cursor/gpt-5.6-sol', name: 'GPT-5.6 Sol' },
          {
            provider: 'openai-codex',
            id: 'gpt-5.6-sol',
            selector: 'openai-codex/gpt-5.6-sol',
            name: 'GPT-5.6-Sol'
          },
          {
            provider: 'openai-codex',
            id: 'gpt-6-astra',
            selector: 'openai-codex/gpt-6-astra',
            name: 'GPT-6-Astra'
          }
        ]
      })
    ).toEqual([
      { id: 'composer-2.5', label: 'Composer 2.5' },
      { id: 'cursor/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { id: 'openai-codex/gpt-5.6-sol', label: 'GPT-5.6-Sol' },
      { id: 'gpt-6-astra', label: 'GPT-6-Astra' }
    ])
  })
})

describe('uniqueModels', () => {
  it('keeps the first label for a repeated id', () => {
    expect(
      uniqueModels([
        { id: 'a', label: 'First' },
        { id: 'a', label: 'Second' },
        { id: 'b', label: 'Bee' }
      ])
    ).toEqual([
      { id: 'a', label: 'First' },
      { id: 'b', label: 'Bee' }
    ])
  })
})

describe('mergeCatalogs', () => {
  it('keeps previous entries when a refresh returns empty', () => {
    expect(
      mergeCatalogs(
        { codex: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }] },
        { codex: [], cursor: [{ id: 'auto', label: 'Auto' }] }
      )
    ).toEqual({
      codex: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }],
      cursor: [{ id: 'auto', label: 'Auto' }]
    })
  })
})

describe('filterModels', () => {
  const rows = [
    { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'openai/gpt-5.6', label: 'GPT-5.6' }
  ]

  it('matches label or id and keeps the full list when the query is empty', () => {
    expect(filterModels(rows, '')).toEqual(rows)
    expect(filterModels(rows, '  gpt  ').map((m) => m.id)).toEqual(['openai/gpt-5.6'])
    expect(filterModels(rows, 'anthropic').map((m) => m.id)).toEqual(['anthropic/claude-sonnet-5'])
  })
})

describe('groupModels', () => {
  it('groups slash-style ids by prefix and leaves bare ids unlabeled', () => {
    expect(
      groupModels([
        { id: 'auto', label: 'Auto' },
        { id: 'anthropic/claude-sonnet-5', label: 'Sonnet 5' },
        { id: 'anthropic/claude-opus-5', label: 'Opus 5' },
        { id: 'openai/gpt-5.6', label: 'GPT-5.6' }
      ])
    ).toEqual([
      { key: '', label: '', models: [{ id: 'auto', label: 'Auto' }] },
      {
        key: 'anthropic',
        label: 'anthropic',
        models: [
          { id: 'anthropic/claude-sonnet-5', label: 'Sonnet 5' },
          { id: 'anthropic/claude-opus-5', label: 'Opus 5' }
        ]
      },
      { key: 'openai', label: 'openai', models: [{ id: 'openai/gpt-5.6', label: 'GPT-5.6' }] }
    ])
  })
})
