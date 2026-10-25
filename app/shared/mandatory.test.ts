import { describe, expect, it } from 'vitest'
import type { Pipeline } from './types'
import {
  isWriteToolName,
  mandatoryOptOutError,
  mergeWithMandatory,
  turnChangedFiles
} from './mandatory'

const lint: Pipeline = {
  id: 'lint',
  name: 'Lint',
  mandatory: true,
  nodes: [{ id: 'n1', name: 'Lint', type: 'shell', cmd: 'npm run lint', after: [], x: 0, y: 0 }]
}

const test: Pipeline = {
  id: 'test',
  name: 'Test',
  nodes: [{ id: 'n1', name: 'Test', type: 'shell', cmd: 'npm test', after: [], x: 0, y: 0 }]
}

describe('mergeWithMandatory', () => {
  it('prepends mandatory pipelines the agent omitted', () => {
    expect(mergeWithMandatory([lint, test], [test]).map((p) => p.id)).toEqual(['lint', 'test'])
  })

  it('dedupes when the agent already selected mandatory pipelines', () => {
    expect(mergeWithMandatory([lint, test], [lint, test]).map((p) => p.id)).toEqual(['lint', 'test'])
  })
})

describe('mandatoryOptOutError', () => {
  it('rejects an empty selection after file-changing tools', () => {
    const error = mandatoryOptOutError([lint, test], [], true)
    expect(error).toContain('lint')
    expect(error).toContain('FAROL_PIPELINES')
  })

  it('allows opt-out when no files changed, a pipeline is selected, or none are mandatory', () => {
    expect(mandatoryOptOutError([lint, test], [], false)).toBeUndefined()
    expect(mandatoryOptOutError([lint, test], [test], true)).toBeUndefined()
    expect(mandatoryOptOutError([test], [], true)).toBeUndefined()
  })
})

describe('isWriteToolName', () => {
  it('matches write-tool aliases including NotebookEdit', () => {
    expect(isWriteToolName('NotebookEdit')).toBe(true)
    expect(isWriteToolName('EditNotebook')).toBe(true)
    expect(isWriteToolName('StrReplace')).toBe(true)
    expect(isWriteToolName('Write')).toBe(true)
    // OMP rewrites files through ast_edit as well as write/edit.
    expect(isWriteToolName('ast_edit')).toBe(true)
  })

  it('does not persist shell or Cursor goal tools as writes', () => {
    expect(isWriteToolName('shell')).toBe(false)
    expect(isWriteToolName('CreateGoal')).toBe(false)
    expect(isWriteToolName('UpdateGoal')).toBe(false)
    expect(isWriteToolName('Read')).toBe(false)
  })
})

describe('turnChangedFiles', () => {
  it('trusts differing snapshots, however the files were written', () => {
    expect(turnChangedFiles(false, 'tree-a', 'tree-b')).toBe(true)
    expect(turnChangedFiles(false, 'tree-a', 'tree-a')).toBe(false)
  })

  it('falls back to write tools without a pair of snapshots', () => {
    expect(turnChangedFiles(true)).toBe(true)
    expect(turnChangedFiles(false)).toBe(false)
    expect(turnChangedFiles(false, 'tree-a', undefined)).toBe(false)
  })

  it('never drops a change a write tool reported', () => {
    expect(turnChangedFiles(true, 'tree-a', 'tree-a')).toBe(true)
  })
})
