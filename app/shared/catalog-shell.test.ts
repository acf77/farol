import { describe, expect, it } from 'vitest'
import {
  catalogShellCommands,
  isShellToolName,
  matchedCatalogShells,
  pipelinesForCatalogCmds
} from './catalog-shell'

const pipelines = [
  {
    id: 'lint',
    name: 'Lint',
    nodes: [
      { type: 'shell', cmd: 'npx tsc --noEmit' },
      { type: 'ai', cmd: 'review' }
    ]
  },
  {
    id: 'ship',
    name: 'Ship',
    nodes: [{ type: 'shell', cmd: '  npm test  ' }]
  }
]

describe('catalogShellCommands', () => {
  it('returns unique normalized shell cmds only', () => {
    expect(catalogShellCommands(pipelines)).toEqual(['npx tsc --noEmit', 'npm test'])
  })
})

describe('isShellToolName', () => {
  it('recognizes Claude, Cursor, and Codex shell tools', () => {
    expect(isShellToolName('shell')).toBe(true)
    expect(isShellToolName('Bash')).toBe(true)
    expect(isShellToolName('command_execution')).toBe(true)
    expect(isShellToolName('shellToolCall')).toBe(true)
    expect(isShellToolName('apply_patch')).toBe(false)
    expect(isShellToolName('Read')).toBe(false)
  })
})

describe('matchedCatalogShells', () => {
  const catalog = catalogShellCommands(pipelines)

  it('matches exact and prefixed invocations', () => {
    expect(matchedCatalogShells(['npm test'], catalog)).toEqual(['npm test'])
    expect(matchedCatalogShells(['npx tsc --noEmit --pretty false'], catalog)).toEqual([
      'npx tsc --noEmit'
    ])
  })

  it('matches truncated stream details against longer catalog cmds', () => {
    const long = 'npx eslint . --max-warnings 0'
    const truncated = `${long.slice(0, 20)}…`
    expect(matchedCatalogShells([truncated], [long])).toEqual([long])
  })

  it('ignores unrelated shell work', () => {
    expect(matchedCatalogShells(['git status', 'ls src'], catalog)).toEqual([])
  })
})

describe('pipelinesForCatalogCmds', () => {
  it('returns only pipelines that own the matched cmds', () => {
    expect(pipelinesForCatalogCmds(pipelines, ['npm test']).map((p) => p.id)).toEqual(['ship'])
    expect(pipelinesForCatalogCmds(pipelines, ['npx tsc --noEmit', 'npm test']).map((p) => p.id)).toEqual([
      'lint',
      'ship'
    ])
  })
})
