import { describe, expect, it } from 'vitest'
import {
  mergeCatalogs,
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
          }
        ]
      })
    ).toEqual([{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }])
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
