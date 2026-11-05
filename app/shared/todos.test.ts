import { describe, expect, it } from 'vitest'
import { lastControlLine } from './control-line'
import {
  TODOS_MARKER,
  activeTodo,
  formatTodos,
  isAgentTodoToolName,
  mergeTodos,
  parseTodos,
  parseTodosValue,
  sanitizeTodos,
  todoProgress,
  todoSummary,
  type Todo
} from './todos'

/** What the controller does with a reply: the last marker line, then its JSON. */
const parseMarker = (text: string): Todo[] | null =>
  parseTodosValue(lastControlLine(text, TODOS_MARKER) ?? '')

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

  it('keeps the source and change time, and drops malformed ones without losing the item', () => {
    const source = { chatId: 'agent:1', title: 'Fix login' }
    expect(sanitizeTodos([{ content: 'a', source, changedAt: 5 }])).toEqual([
      { content: 'a', status: 'pending', priority: 'medium', source, changedAt: 5 }
    ])
    expect(sanitizeTodos([{ content: 'a', source: { chatId: 1 }, changedAt: 'soon' }])).toEqual([
      { content: 'a', status: 'pending', priority: 'medium' }
    ])
  })
})

describe('parseTodos', () => {
  it('accepts an empty list and normalizes valid entries', () => {
    expect(parseTodos([])).toEqual([])
    expect(parseTodos([{ content: '  Ship it  ', status: 'pending', priority: 'high' }])).toEqual([
      { content: 'Ship it', status: 'pending', priority: 'high' }
    ])
  })

  it('keeps well-formed stamps and drops a malformed one without rejecting the list', () => {
    const source = { chatId: 'agent:1', title: 'Fix login' }
    expect(
      parseTodos([
        { content: 'a', status: 'pending', priority: 'low', source, changedAt: 7 },
        { content: 'b', status: 'pending', priority: 'low', source: 'x', changedAt: Infinity }
      ])
    ).toEqual([
      { content: 'a', status: 'pending', priority: 'low', source, changedAt: 7 },
      { content: 'b', status: 'pending', priority: 'low' }
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

describe('parseTodosValue', () => {
  it('reads the JSON on the marker line', () => {
    const line = `${TODOS_MARKER} [{"content":"a","status":"completed","priority":"low"}]`
    expect(parseMarker(`Done\n${line}\nFAROL_PIPELINES: []`)).toEqual([
      { content: 'a', status: 'completed', priority: 'low' }
    ])
  })

  it('clears the list on an empty array', () => {
    expect(parseMarker(`Work\n${TODOS_MARKER} []\nFAROL_PIPELINES: []`)).toEqual([])
  })

  it('uses the last marker when a reply repeats it', () => {
    const old = `${TODOS_MARKER} [{"content":"old","status":"pending","priority":"low"}]`
    const next = `${TODOS_MARKER} [{"content":"new","status":"pending","priority":"low"}]`
    expect(parseMarker(`${old}\n${next}\nFAROL_PIPELINES: []`)?.map((todo) => todo.content)).toEqual([
      'new'
    ])
  })

  it('accepts a line with no marker after it, as a line at the start of a reply has none', () => {
    expect(parseMarker(`${TODOS_MARKER} []`)).toEqual([])
  })

  it('ignores a missing or malformed line', () => {
    expect(parseMarker('Nothing here')).toBeNull()
    expect(parseMarker(`${TODOS_MARKER} not json\nFAROL_PIPELINES: []`)).toBeNull()
    expect(parseMarker(`${TODOS_MARKER} {"content":"x"}\nFAROL_PIPELINES: []`)).toBeNull()
  })

  it('ignores a marker inside a fenced code example', () => {
    const example = [
      'Update it like this:',
      '```',
      `${TODOS_MARKER} [{"content":"fake","status":"pending","priority":"low"}]`,
      '```',
      'FAROL_PIPELINES: []'
    ].join('\n')
    expect(parseMarker(example)).toBeNull()
  })
})

describe('mergeTodos', () => {
  const chat = { chatId: 'agent:2', title: 'Add dark mode' }
  const earlier = { chatId: 'agent:1', title: 'Fix login' }
  const todo = (content: string, status: Todo['status'] = 'pending'): Todo => ({
    content,
    status,
    priority: 'medium'
  })

  it('stamps a new item with the chat and the time', () => {
    expect(mergeTodos([], [todo('a')], chat, 100)).toEqual([{ ...todo('a'), source: chat, changedAt: 100 }])
  })

  it('keeps the source and the time of an item that did not change', () => {
    const previous = [{ ...todo('a'), source: earlier, changedAt: 50 }]
    expect(mergeTodos(previous, [todo('a')], chat, 100)).toEqual(previous)
  })

  it('moves the time but keeps the source when status changes', () => {
    const previous = [{ ...todo('a'), source: earlier, changedAt: 50 }]
    expect(mergeTodos(previous, [todo('a', 'completed')], chat, 100)).toEqual([
      { ...todo('a', 'completed'), source: earlier, changedAt: 100 }
    ])
  })

  it('ignores what the agent wrote in the stamped fields', () => {
    const forged = { ...todo('a'), source: earlier, changedAt: 1 }
    expect(mergeTodos([], [forged], chat, 100)).toEqual([{ ...todo('a'), source: chat, changedAt: 100 }])
  })

  it('does not claim an old item without a source, and gives a developer edit none', () => {
    expect(mergeTodos([todo('a')], [todo('a'), todo('b')], undefined, 100)).toEqual([
      todo('a'),
      { ...todo('b'), changedAt: 100 }
    ])
  })
})

describe('formatTodos', () => {
  const viewer = { chatId: 'agent:1', now: 10 * 3_600_000, since: 9 * 3_600_000 }

  it('lists status, priority, and content', () => {
    expect(formatTodos([{ content: 'a', status: 'in_progress', priority: 'high' }], viewer)).toBe(
      '- [in_progress] (high) a'
    )
  })

  it('says so when empty', () => {
    expect(formatTodos([], viewer)).toBe('No todos yet.')
  })

  it('notes the chat and the age of an item', () => {
    const todos: Todo[] = [
      {
        content: 'mine',
        status: 'in_progress',
        priority: 'high',
        source: { chatId: 'agent:1', title: 'Fix login' },
        changedAt: viewer.now - 120_000
      },
      {
        content: 'theirs',
        status: 'pending',
        priority: 'low',
        source: { chatId: 'agent:2', title: 'Add dark mode' },
        changedAt: viewer.now - 2 * 3_600_000
      }
    ]
    expect(formatTodos(todos, viewer)).toBe(
      [
        '- [in_progress] (high) mine ⟨this chat · 2m ago⟩',
        '- [pending] (low) theirs ⟨chat "Add dark mode" · 2h ago⟩'
      ].join('\n')
    )
  })

  it('marks a finished item from before the current request', () => {
    const source = { chatId: 'agent:2', title: 'Old chat' }
    const todos: Todo[] = [
      { content: 'old', status: 'completed', priority: 'low', source, changedAt: viewer.since - 1 },
      { content: 'new', status: 'completed', priority: 'low', source, changedAt: viewer.since },
      { content: 'legacy', status: 'cancelled', priority: 'low' }
    ]
    expect(formatTodos(todos, viewer)).toBe(
      [
        '- [completed] (low) old ⟨chat "Old chat" · 1h ago · earlier request⟩',
        '- [completed] (low) new ⟨chat "Old chat" · 1h ago⟩',
        '- [cancelled] (low) legacy ⟨earlier request⟩'
      ].join('\n')
    )
  })
})

describe('isAgentTodoToolName', () => {
  it('knows the CLI todo tools by any spelling', () => {
    for (const name of ['TodoWrite', 'todowrite', 'todo_read', 'update_plan']) {
      expect(isAgentTodoToolName(name)).toBe(true)
    }
    for (const name of ['Edit', 'todo']) expect(isAgentTodoToolName(name)).toBe(false)
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

    expect(parseMarker(marker)).toEqual(todos)
  })
})

describe('todoProgress', () => {
  it('counts completed items over the full list length', () => {
    expect(
      todoProgress([
        { content: 'a', status: 'completed', priority: 'low' },
        { content: 'b', status: 'in_progress', priority: 'high' },
        { content: 'c', status: 'cancelled', priority: 'low' }
      ])
    ).toEqual({ done: 1, total: 3, label: '1 of 3 todos completed' })
  })
})

describe('activeTodo', () => {
  const sample = [
    { content: 'done', status: 'completed' as const, priority: 'low' as const },
    { content: 'waiting', status: 'pending' as const, priority: 'medium' as const },
    { content: 'now', status: 'in_progress' as const, priority: 'high' as const }
  ]

  it('prefers in_progress, then pending, then the latest completed', () => {
    expect(activeTodo(sample)?.content).toBe('now')
    expect(activeTodo(sample.filter((todo) => todo.status !== 'in_progress'))?.content).toBe('waiting')
    expect(activeTodo(sample.filter((todo) => todo.status === 'completed'))?.content).toBe('done')
  })

  it('is undefined for an empty list', () => {
    expect(activeTodo([])).toBeUndefined()
  })
})
