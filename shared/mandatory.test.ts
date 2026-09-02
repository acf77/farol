import { describe, expect, it } from 'vitest'
import type { Pipeline } from './types'
import {
  isCodeChangeToolName,
  mandatoryOptOutError,
  mergeWithMandatory
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
  it('rejects an empty selection after code-changing tools', () => {
    const error = mandatoryOptOutError([lint, test], [], true)
    expect(error).toContain('lint')
    expect(error).toContain('FAROL_PIPELINES')
  })

  it('allows opt-out when no code changed, a pipeline is selected, or none are mandatory', () => {
    expect(mandatoryOptOutError([lint, test], [], false)).toBeUndefined()
    expect(mandatoryOptOutError([lint, test], [test], true)).toBeUndefined()
    expect(mandatoryOptOutError([test], [], true)).toBeUndefined()
  })
})

describe('isCodeChangeToolName', () => {
  it('treats shell and edit tools as code changes', () => {
    expect(isCodeChangeToolName('shell')).toBe(true)
    expect(isCodeChangeToolName('apply_patch')).toBe(true)
    expect(isCodeChangeToolName('Write')).toBe(true)
  })

  it('does not treat read-only tools as code changes', () => {
    expect(isCodeChangeToolName('Read')).toBe(false)
    expect(isCodeChangeToolName('grep')).toBe(false)
  })
})
