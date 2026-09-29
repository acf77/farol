import { describe, expect, it } from 'vitest'
import {
  ancestorVars,
  ancestors,
  chainLevels,
  chainToNodes,
  connectorKind,
  descendants,
  expandVars,
  namedStepOutput,
  newPipelineNode,
  parallelAsClashIds,
  quoteShellArg,
  readyIds,
  sanitizeAs,
  sanitizePipeline,
  topoSort,
  validateRunnable
} from './graph'
import { VERDICT_MARKER } from './verdict'
import type { PipelineNode } from './types'

const n = (
  id: string,
  after: string[],
  extra: Partial<PipelineNode> = {}
): PipelineNode => ({
  id,
  name: id,
  type: extra.type ?? 'ai',
  cmd: extra.cmd ?? '',
  after,
  gate: extra.gate,
  x: extra.x ?? 0,
  y: extra.y ?? 0,
  ...extra
})

describe('chainToNodes', () => {
  it('wires each step to the previous', () => {
    const nodes = chainToNodes([
      { name: 'A', type: 'shell', cmd: 'echo a' },
      { name: 'B', type: 'ai', cmd: 'review' }
    ])
    expect(nodes.map((x) => x.id)).toEqual(['n1', 'n2'])
    expect(nodes[0].after).toEqual([])
    expect(nodes[1].after).toEqual(['n1'])
    expect(nodes[0].gate).toBe(true)
    expect(nodes[1].gate).toBe(false)
    expect(nodes[1].ai).toBe('claude')
    expect(nodes[1].model).toBeUndefined()
  })

  it('keeps a model on an AI step', () => {
    const nodes = chainToNodes([{ name: 'B', type: 'ai', ai: 'cursor', model: 'composer-2.5', cmd: 'review' }])
    expect(nodes[0].ai).toBe('cursor')
    expect(nodes[0].model).toBe('composer-2.5')
  })
})

describe('newPipelineNode', () => {
  it('adds unique shell and AI cards after the current graph', () => {
    const first = newPipelineNode([], 'shell')
    const second = newPipelineNode([first], 'ai')
    expect(first).toMatchObject({ id: 'n1', type: 'shell', gate: true, x: 72, y: 48 })
    expect(second).toMatchObject({ id: 'n2', type: 'ai', ai: 'claude', gate: false, x: 72, y: 160 })
  })
})

describe('topoSort / readyIds', () => {
  const graph = [
    n('a', [], { type: 'shell' }),
    n('b', ['a']),
    n('c', ['a']),
    n('d', ['b', 'c'])
  ]

  it('orders fan-out then fan-in', () => {
    const t = topoSort(graph)
    expect(t?.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('starts roots, then both children of a, then the join', () => {
    expect(readyIds(graph, new Set(), new Set(), new Set())).toEqual(['a'])
    expect(readyIds(graph, new Set(['a']), new Set(), new Set())).toEqual(['b', 'c'])
    expect(readyIds(graph, new Set(['a', 'b']), new Set(), new Set())).toEqual(['c'])
    expect(readyIds(graph, new Set(['a', 'b', 'c']), new Set(), new Set())).toEqual(['d'])
  })

  it('returns null on a cycle', () => {
    expect(topoSort([n('a', ['b']), n('b', ['a'])])).toBeNull()
  })
})

describe('ancestors / descendants', () => {
  const graph = [n('a', []), n('b', ['a']), n('c', ['a']), n('d', ['b', 'c'])]
  it('walks both directions', () => {
    expect(ancestors(graph, 'd').sort()).toEqual(['a', 'b', 'c'])
    expect(descendants(graph, 'a').sort()).toEqual(['b', 'c', 'd'])
  })
})

describe('connectorKind', () => {
  it('labels siblings in a parallel group as and', () => {
    const topo = [n('a', []), n('b', ['a']), n('c', ['a'])]
    expect(connectorKind(topo, 1)).toBe('then')
    expect(connectorKind(topo, 2)).toBe('and')
  })
})

describe('chainLevels', () => {
  const ids = (nodes: PipelineNode[]): string[][] =>
    chainLevels(nodes).map((l) => l.steps.map((s) => s.node.id))

  it('keeps a linear chain one step per level', () => {
    const graph = [n('a', []), n('b', ['a']), n('c', ['b'])]
    expect(ids(graph)).toEqual([['a'], ['b'], ['c']])
    expect(chainLevels(graph).map((l) => l.steps[0].join)).toEqual([null, 'then', 'then'])
  })

  it('puts a fan-out on one level', () => {
    expect(ids([n('a', []), n('b', ['a']), n('c', ['a'])])).toEqual([['a'], ['b', 'c']])
  })

  it('holds a fan-in until both parents have run', () => {
    expect(ids([n('a', []), n('b', []), n('c', ['a', 'b'])])).toEqual([['a', 'b'], ['c']])
  })

  it('opens and closes a diamond', () => {
    const graph = [n('a', []), n('b', ['a']), n('c', ['a']), n('d', ['b', 'c'])]
    expect(ids(graph)).toEqual([['a'], ['b', 'c'], ['d']])
    const steps = chainLevels(graph).flatMap((l) => l.steps)
    expect(steps.map((s) => s.index)).toEqual([1, 2, 3, 4])
    expect(steps.map((s) => s.join)).toEqual([null, 'then', 'and', 'then'])
  })

  it('starts a disconnected node alongside the root', () => {
    expect(ids([n('a', []), n('b', ['a']), n('z', [])])).toEqual([['a', 'z'], ['b']])
  })

  it('numbers every node exactly once', () => {
    const graph = [n('a', []), n('b', ['a']), n('c', ['a']), n('d', ['b', 'c']), n('z', [])]
    const steps = chainLevels(graph).flatMap((l) => l.steps)
    expect(steps.map((s) => s.node.id).sort()).toEqual(['a', 'b', 'c', 'd', 'z'])
    expect(steps.map((s) => s.index)).toEqual([1, 2, 3, 4, 5])
  })

  it('falls back to declaration order on a cycle', () => {
    expect(ids([n('a', ['b']), n('b', ['a'])])).toEqual([['a'], ['b']])
  })

  it('returns nothing for an empty pipeline', () => {
    expect(chainLevels([])).toEqual([])
  })
})

describe('sanitizePipeline', () => {
  it('migrates a legacy steps list', () => {
    const p = sanitizePipeline({
      id: 'x',
      name: 'X',
      steps: [{ name: 'echo', type: 'shell', cmd: 'echo hi' }]
    })
    expect(p?.nodes).toHaveLength(1)
    expect(p?.nodes[0].id).toBe('n1')
    expect(p?.nodes[0].cmd).toBe('echo hi')
  })

  it('keeps a fan-out DAG', () => {
    const p = sanitizePipeline({
      id: 'x',
      name: 'X',
      nodes: [
        { id: 'a', name: 'A', type: 'shell', cmd: 'a', after: [], x: 0, y: 0 },
        { id: 'b', name: 'B', type: 'ai', cmd: 'b', after: ['a'], x: 0, y: 1 },
        { id: 'c', name: 'C', type: 'ai', cmd: 'c', after: ['a'], x: 1, y: 1 }
      ]
    })
    expect(p?.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(p?.nodes[1].after).toEqual(['a'])
    expect(p?.nodes[2].after).toEqual(['a'])
    expect(p?.nodes[1].gate).toBe(false)
    expect(p?.nodes[0].gate).toBe(true)
  })

  it('keeps an AI step model id', () => {
    const p = sanitizePipeline({
      id: 'x',
      name: 'X',
      nodes: [
        {
          id: 'a',
          name: 'A',
          type: 'ai',
          ai: 'cursor',
          model: 'composer-2.5',
          cmd: 'review',
          after: [],
          x: 0,
          y: 0
        }
      ]
    })
    expect(p?.nodes[0].ai).toBe('cursor')
    expect(p?.nodes[0].model).toBe('composer-2.5')
  })

  it('drops a blank model so the CLI default applies', () => {
    const p = sanitizePipeline({
      id: 'x',
      name: 'X',
      nodes: [{ id: 'a', name: 'A', type: 'ai', ai: 'claude', model: '  ', cmd: 'x', after: [], x: 0, y: 0 }]
    })
    expect(p?.nodes[0].model).toBeUndefined()
  })

  it('strips leftover AI fields from a shell step', () => {
    const p = sanitizePipeline({
      id: 'x',
      name: 'X',
      nodes: [
        {
          id: 'a',
          name: 'A',
          type: 'shell',
          ai: 'claude',
          model: 'opus',
          cmd: 'ls',
          after: [],
          x: 0,
          y: 0
        }
      ]
    })
    expect(p?.nodes[0].ai).toBeUndefined()
    expect(p?.nodes[0].model).toBeUndefined()
  })

  it('keeps valid git hook events and drops unknown ones', () => {
    const p = sanitizePipeline({
      id: 'x',
      name: 'X',
      nodes: [{ id: 'a', name: 'A', type: 'shell', cmd: 'a', after: [], x: 0, y: 0 }],
      gitHooks: ['pre-commit', 'pre-push', 'post-commit', 'pre-commit']
    })
    expect(p?.gitHooks).toEqual(['pre-commit', 'pre-push'])
  })

  it('omits gitHooks entirely once nothing valid is left', () => {
    const p = sanitizePipeline({
      id: 'x',
      name: 'X',
      nodes: [{ id: 'a', name: 'A', type: 'shell', cmd: 'a', after: [], x: 0, y: 0 }],
      gitHooks: ['post-commit']
    })
    expect(p?.gitHooks).toBeUndefined()
  })

  it('drops duplicate node ids', () => {
    const p = sanitizePipeline({
      id: 'x',
      name: 'X',
      nodes: [
        { id: 'a', name: 'A', type: 'shell', cmd: 'a', after: [], x: 0, y: 0 },
        { id: 'a', name: 'Dup', type: 'shell', cmd: 'dup', after: [], x: 0, y: 1 }
      ]
    })
    expect(p?.nodes).toHaveLength(1)
    expect(p?.nodes[0].name).toBe('A')
  })

  it('keeps a valid as and clears an invalid one', () => {
    const ok = sanitizePipeline({
      id: 'x',
      name: 'X',
      nodes: [{ id: 'a', name: 'A', type: 'shell', cmd: 'a', as: 'diff_1', after: [], x: 0, y: 0 }]
    })
    expect(ok?.nodes[0].as).toBe('diff_1')
    const bad = sanitizePipeline({
      id: 'x',
      name: 'X',
      nodes: [{ id: 'a', name: 'A', type: 'shell', cmd: 'a', as: 'bad-name', after: [], x: 0, y: 0 }]
    })
    expect(bad?.nodes[0].as).toBeUndefined()
  })

  it('persists mandatory only when true', () => {
    const nodes = [{ id: 'a', name: 'A', type: 'shell', cmd: 'a', after: [], x: 0, y: 0 }]
    expect(sanitizePipeline({ id: 'lint', name: 'Lint', mandatory: true, nodes })?.mandatory).toBe(true)
    expect(sanitizePipeline({ id: 'x', name: 'X', mandatory: false, nodes })?.mandatory).toBeUndefined()
    expect(sanitizePipeline({ id: 'e', name: 'E', mandatory: true, nodes: [] })?.mandatory).toBe(true)
  })

  it('persists autoSelectable only when true', () => {
    const nodes = [{ id: 'a', name: 'A', type: 'shell', cmd: 'a', after: [], x: 0, y: 0 }]
    expect(
      sanitizePipeline({ id: 'sec', name: 'Sec', autoSelectable: true, nodes })?.autoSelectable
    ).toBe(true)
    expect(
      sanitizePipeline({ id: 'x', name: 'X', autoSelectable: false, nodes })?.autoSelectable
    ).toBeUndefined()
  })

  it('persists target only when remote', () => {
    const nodes = [{ id: 'a', name: 'A', type: 'shell', cmd: 'a', after: [], x: 0, y: 0 }]
    expect(sanitizePipeline({ id: 'r', name: 'R', target: 'remote', nodes })?.target).toBe('remote')
    expect(sanitizePipeline({ id: 'r', name: 'R', target: 'vercel', nodes })?.target).toBe('remote')
    expect(sanitizePipeline({ id: 'x', name: 'X', target: 'local', nodes })?.target).toBeUndefined()
    expect(sanitizePipeline({ id: 'y', name: 'Y', target: 'aws', nodes })?.target).toBeUndefined()
  })
})

describe('named outputs', () => {
  it('sanitizes as ids and expands ${name}', () => {
    expect(sanitizeAs('diff')).toBe('diff')
    expect(sanitizeAs('_out')).toBe('_out')
    expect(sanitizeAs('foo-bar')).toBeUndefined()
    expect(expandVars('see ${diff} end', { diff: 'abc' })).toBe('see abc end')
    expect(expandVars('${missing}', {})).toBe('')
    expect(expandVars('keep ${not-id}', {})).toBe('keep ${not-id}')
    expect(expandVars('npm version ${version}', { version: 'minor' }, { quote: quoteShellArg })).toBe(
      "npm version 'minor'"
    )
    expect(
      expandVars('npm version ${version} --flag', { version: "a\nFAROL\n'x'" }, { quote: quoteShellArg })
    ).toBe("npm version 'a\nFAROL\n'\\''x'\\''' --flag")
  })

  it('strips verdict lines from named step outputs used as vars', () => {
    expect(namedStepOutput(`minor\n${VERDICT_MARKER} pass\n`)).toBe('minor')
    const chain = [n('a', [], { as: 'version', type: 'shell' }), n('b', ['a'])]
    expect(
      ancestorVars(chain, 'b', { a: `minor\n${VERDICT_MARKER} pass\n` }, new Map([['a', { ok: true }]]))
    ).toEqual({ version: 'minor' })
  })

  it('builds ancestor vars: last-wins, fail→empty, siblings ignored', () => {
    const chain = [
      n('a', [], { as: 'diff', type: 'shell' }),
      n('b', ['a'], { as: 'diff' }),
      n('c', ['b'])
    ]
    const results = new Map([
      ['a', { ok: true }],
      ['b', { ok: true }]
    ])
    expect(ancestorVars(chain, 'c', { a: 'first', b: 'second' }, results)).toEqual({
      diff: 'second'
    })
    results.set('b', { ok: false })
    expect(ancestorVars(chain, 'c', { a: 'first', b: 'second' }, results)).toEqual({
      diff: ''
    })

    const fork = [
      n('a', [], { as: 'x', type: 'shell' }),
      n('b', [], { as: 'y', type: 'shell' }),
      n('c', ['a'])
    ]
    expect(
      ancestorVars(
        fork,
        'c',
        { a: 'A', b: 'B' },
        new Map([
          ['a', { ok: true }],
          ['b', { ok: true }]
        ])
      )
    ).toEqual({ x: 'A' })
  })

  it('flags parallel as clashes and allows chained last-wins', () => {
    expect(
      [...parallelAsClashIds([n('a', [], { as: 'out', type: 'shell' }), n('b', [], { as: 'out', type: 'shell' })])].sort()
    ).toEqual(['a', 'b'])
    expect(
      parallelAsClashIds([
        n('a', [], { as: 'out', type: 'shell' }),
        n('b', ['a'], { as: 'out' })
      ]).size
    ).toBe(0)
  })
})

describe('validateRunnable', () => {
  it('rejects cycles and duplicate ids', () => {
    expect(validateRunnable([n('a', ['b']), n('b', ['a'])])).toMatch(/cycle/i)
    expect(validateRunnable([n('a', []), n('a', [])])).toMatch(/duplicate/i)
    expect(validateRunnable([n('a', []), n('b', ['a'])])).toBeNull()
  })

  it('rejects parallel as clashes', () => {
    expect(
      validateRunnable([
        n('a', [], { as: 'x', type: 'shell' }),
        n('b', [], { as: 'x', type: 'shell' })
      ])
    ).toMatch(/parallel/i)
  })
})
