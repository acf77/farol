import { describe, expect, it } from 'vitest'
import {
  TODOS_MARKER,
  formatTodos,
  parseTodos,
  parseTodosMarker,
  sanitizeTodos,
  todoSummary
} from './todos'

describe('sanitizeTodos', () => {
  it('defaults status and priority and trims content', () => {
    expect(sanitizeTodos([{ content: '  Ship it  ' }])).toEqual([
      { content: 'Ship it', status: 'pending', priority: 'medium' }
    ])
  })

  it('accepts bare strings and drops empty or malformed entries', () => {
    expect(sanitizeTodos(['Do the thing', '', { nope: true }, null, 3])).toEqual([
      { content: 'Do the thing', status: 'pending', priority: 'medium' }
    ])
  })

  it('keeps known statuses and priorities', () => {
    expect(sanitizeTodos([{ content: 'x', status: 'in_progress', priority: 'high' }])).toEqual([
      { content: 'x', status: 'in_progress', priority: 'high' }
    ])
  })

  it('is empty for a non-array', () => {
    expect(sanitizeTodos({ content: 'x' })).toEqual([])
  })
})

describe('parseTodos', () => {
  it('accepts an empty list and normalizes valid entries', () => {
    expect(parseTodos([])).toEqual([])
    expect(parseTodos([{ content: '  Ship it  ', status: 'pending', priority: 'high' }])).toEqual([
      { content: 'Ship it', status: 'pending', priority: 'high' }
    ])
  })

  it.each([
    null,
    undefined,
    {},
    '[]',
    ['Ship it'],
    [{ content: 'Ship it' }],
    [{ content: ' ', status: 'pending', priority: 'high' }],
    [{ content: 'Ship it', status: 'unknown', priority: 'high' }],
    [{ content: 'Ship it', status: 'pending', priority: 'unknown' }],
    [{ content: 'Ship it', status: 'pending', priority: 'high' }, null],
    Array(1)
  ].map((value) => [value]))('rejects malformed input without clearing or partially accepting it: %j', (value) => {
    expect(parseTodos(value)).toBeNull()
  })
})

describe('parseTodosMarker', () => {
  it('reads the JSON on the marker line', () => {
    const line = `${TODOS_MARKER} [{"content":"a","status":"completed","priority":"low"}]`
    expect(parseTodosMarker(`Done\n${line}\nFAROL_PIPELINES: []`)).toEqual([
      { content: 'a', status: 'completed', priority: 'low' }
    ])
  })

  it('clears the list on an empty array', () => {
    expect(parseTodosMarker(`Work\n${TODOS_MARKER} []\nFAROL_PIPELINES: []`)).toEqual([])
  })

  it('uses the last marker when a reply repeats it', () => {
    const old = `${TODOS_MARKER} [{"content":"old","status":"pending","priority":"low"}]`
    const next = `${TODOS_MARKER} [{"content":"new","status":"pending","priority":"low"}]`
    expect(parseTodosMarker(`${old}\n${next}\nFAROL_PIPELINES: []`)?.map((todo) => todo.content)).toEqual([
      'new'
    ])
  })

  it('ignores a missing, last-line, or malformed marker', () => {
    expect(parseTodosMarker('Nothing here')).toBeNull()
    expect(parseTodosMarker(`${TODOS_MARKER} []`)).toBeNull()
    expect(parseTodosMarker(`${TODOS_MARKER} not json\nFAROL_PIPELINES: []`)).toBeNull()
    expect(parseTodosMarker(`${TODOS_MARKER} {"content":"x"}\nFAROL_PIPELINES: []`)).toBeNull()
  })

  it('ignores a marker inside a fenced code example', () => {
    const example = [
      'Update it like this:',
      '```',
      `${TODOS_MARKER} [{"content":"fake","status":"pending","priority":"low"}]`,
      '```',
      'FAROL_PIPELINES: []'
    ].join('\n')
    expect(parseTodosMarker(example)).toBeNull()
  })
})

describe('formatTodos', () => {
  it('lists status, priority, and content', () => {
    expect(formatTodos([{ content: 'a', status: 'in_progress', priority: 'high' }])).toBe(
      '- [in_progress] (high) a'
    )
  })

  it('says so when empty', () => {
    expect(formatTodos([])).toBe('No todos yet.')
  })
})

describe('todoSummary', () => {
  it('counts open and done items', () => {
    expect(
      todoSummary([
        { content: 'a', status: 'completed', priority: 'low' },
        { content: 'b', status: 'pending', priority: 'low' }
      ])
    ).toBe('1 open · 1 done')
  })

  it('names a cleared list', () => {
    expect(todoSummary([])).toBe('Todo list cleared')
  })

  it('preserves full replacements without arbitrary item or content caps', () => {
    const todos = Array.from({ length: 101 }, (_, index) => ({
      content: `item ${index} ${'x'.repeat(250)}`,
      status: 'pending' as const,
      priority: 'low' as const
    }))
    const marker = `${TODOS_MARKER} ${JSON.stringify(todos)}\nFAROL_PIPELINES: []`

    expect(parseTodosMarker(marker)).toEqual(todos)
  })
})
