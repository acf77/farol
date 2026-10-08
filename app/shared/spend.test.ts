import { describe, expect, it } from 'vitest'
import {
  SpendBook,
  addAnthropicCost,
  addAnthropicUsage,
  addOpenAICost,
  addOpenRouterActivity,
  heatLevel,
  lineItemModel,
  totalsSince
} from './spend'

describe('spend parsers', () => {
  it('joins Anthropic tokens and cost by model and day', () => {
    const book = new SpendBook()
    addAnthropicUsage(book, {
      data: [
        {
          starting_at: '2026-10-01T00:00:00Z',
          results: [
            {
              model: 'claude-sonnet-5',
              uncached_input_tokens: 100,
              cache_read_input_tokens: 50,
              cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 5 },
              output_tokens: 20
            }
          ]
        }
      ]
    })
    addAnthropicCost(book, {
      data: [{ starting_at: '2026-10-01T00:00:00Z', results: [{ model: 'claude-sonnet-5', amount: '250.5' }] }]
    })
    expect(book.result()).toEqual([
      { id: 'claude-sonnet-5', name: 'claude-sonnet-5', days: [{ date: '2026-10-01', input: 165, output: 20, cost: 2.505 }] }
    ])
  })

  it('strips the token kind from OpenAI line items', () => {
    expect(lineItemModel('gpt-5, input')).toBe('gpt-5')
    expect(lineItemModel('gpt-5, cached input')).toBe('gpt-5')
    const book = new SpendBook()
    addOpenAICost(book, {
      data: [
        {
          start_time: Date.UTC(2026, 9, 2) / 1000,
          results: [
            { line_item: 'gpt-5, input', amount: { value: 1.5 } },
            { line_item: 'gpt-5, output', amount: { value: 0.5 } }
          ]
        }
      ]
    })
    expect(book.result()[0].days).toEqual([{ date: '2026-10-02', input: 0, output: 0, cost: 2 }])
  })

  it('reads OpenRouter activity rows', () => {
    const book = new SpendBook()
    addOpenRouterActivity(book, {
      data: [{ date: '2026-10-03', model: 'z-ai/glm-5.3', usage: 0.25, prompt_tokens: 10, completion_tokens: 4 }]
    })
    expect(book.result()[0].days[0]).toEqual({ date: '2026-10-03', input: 10, output: 4, cost: 0.25 })
  })

  it('ignores malformed bodies', () => {
    const book = new SpendBook()
    addAnthropicUsage(book, null)
    addOpenRouterActivity(book, { data: 'x' })
    expect(book.result()).toEqual([])
  })
})

describe('views', () => {
  it('totals only days on or after the cutoff, largest first', () => {
    const total = totalsSince(
      {
        provider: 'openai',
        state: 'ok',
        models: [
          { id: 'a', name: 'a', days: [{ date: '2026-09-01', input: 1, output: 1, cost: 9 }] },
          {
            id: 'b',
            name: 'b',
            days: [
              { date: '2026-10-01', input: 5, output: 2, cost: 1 },
              { date: '2026-10-02', input: 5, output: 2, cost: 2 }
            ]
          }
        ]
      },
      '2026-10-01'
    )
    expect(total.models.map((m) => m.id)).toEqual(['b'])
    expect(total.cost).toBe(3)
    expect(total.tokens).toBe(14)
  })

  it('buckets heat levels', () => {
    expect(heatLevel(0, [1, 2, 3])).toBe(0)
    expect(heatLevel(1, [1, 2, 3])).toBe(1)
    expect(heatLevel(2.5, [1, 2, 3])).toBe(3)
    expect(heatLevel(9, [1, 2, 3])).toBe(4)
  })
})
