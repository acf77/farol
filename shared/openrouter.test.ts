import { describe, expect, it } from 'vitest'
import {
  isToolCapable,
  openCodeModel,
  parseOpenRouterCatalog,
  recommendedPins,
  uniqueIds
} from './openrouter'

describe('parseOpenRouterCatalog', () => {
  it('keeps tool-capable models and drops the rest', () => {
    const catalog = parseOpenRouterCatalog({
      data: [
        { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', supported_parameters: ['tools'] },
        { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', supported_parameters: ['temperature'] },
        { id: '  ', name: 'blank', supported_parameters: ['tools'] },
        { id: 'anthropic/claude-sonnet-4', name: 'dup', supported_parameters: ['tools'] }
      ]
    })
    expect(catalog).toEqual([{ id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' }])
  })

  it('returns nothing for junk', () => {
    expect(parseOpenRouterCatalog(null)).toEqual([])
    expect(parseOpenRouterCatalog({ data: 'nope' })).toEqual([])
  })
})

describe('recommendedPins', () => {
  it('pins one model per family from the Farol list', () => {
    const catalog = [
      { id: 'anthropic/claude-sonnet-4', label: 'Sonnet' },
      { id: 'anthropic/claude-3.5-sonnet', label: 'Old Sonnet' },
      { id: 'openai/gpt-4o', label: 'GPT' },
      { id: 'google/gemini-2.5-flash', label: 'Gemini' },
      { id: 'x-ai/grok-4', label: 'Grok' },
      { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama' }
    ]
    expect(recommendedPins(catalog)).toEqual([
      'anthropic/claude-sonnet-4',
      'openai/gpt-4o',
      'google/gemini-2.5-flash',
      'x-ai/grok-4'
    ])
  })

  it('falls back to the first four catalog ids when none match', () => {
    const catalog = [
      { id: 'acme/one', label: '1' },
      { id: 'acme/two', label: '2' },
      { id: 'acme/three', label: '3' },
      { id: 'acme/four', label: '4' },
      { id: 'acme/five', label: '5' }
    ]
    expect(recommendedPins(catalog)).toEqual(['acme/one', 'acme/two', 'acme/three', 'acme/four'])
  })
})

describe('openCodeModel', () => {
  it('prefixes an OpenRouter slug for OpenCode --model', () => {
    expect(openCodeModel('anthropic/claude-sonnet-4')).toBe('openrouter/anthropic/claude-sonnet-4')
    expect(openCodeModel('openrouter/openai/gpt-4o')).toBe('openrouter/openai/gpt-4o')
    expect(openCodeModel('  ')).toBeUndefined()
  })
})

describe('uniqueIds / isToolCapable', () => {
  it('dedupes and trims ids', () => {
    expect(uniqueIds([' a ', 'a', '', 1, 'b'])).toEqual(['a', 'b'])
  })

  it('requires a tools parameter', () => {
    expect(isToolCapable({ supported_parameters: ['tools', 'temperature'] })).toBe(true)
    expect(isToolCapable({ supported_parameters: ['temperature'] })).toBe(false)
  })
})
