import { describe, expect, it } from 'vitest'
import {
  managedCatalogPipelineId,
  repositoryRuntimePrefix,
  scopedRuntimeId,
  unscopedRuntimeId
} from './runtime'

describe('repository runtime ids', () => {
  it('keeps identical local ids separate across repositories', () => {
    const first = scopedRuntimeId('/repos/one', 'p1')
    const second = scopedRuntimeId('/repos/two', 'p1')

    expect(first).not.toBe(second)
    expect(unscopedRuntimeId('/repos/one', first)).toBe('p1')
    expect(unscopedRuntimeId('/repos/two', second)).toBe('p1')
  })

  it('does not apply the same repository scope twice', () => {
    const scoped = scopedRuntimeId('/repos/one/', 'pipeline:lint')

    expect(scopedRuntimeId('/repos/one', scoped)).toBe(scoped)
    expect(scoped.startsWith(repositoryRuntimePrefix('/repos/one'))).toBe(true)
  })

  it('rejects an id owned by another repository', () => {
    const scoped = scopedRuntimeId('/repos/one', 'agent:1')

    expect(unscopedRuntimeId('/repos/two', scoped)).toBeNull()
  })
})

describe('managedCatalogPipelineId', () => {
  it('maps UI and MCP runner slots to the managed Chat catalog form', () => {
    expect(managedCatalogPipelineId('repo-abc:pipeline:lint')).toBe(
      'repo-abc:managed-pipeline:lint'
    )
    expect(managedCatalogPipelineId('repo-abc:mcp-pipeline:lint')).toBe(
      'repo-abc:managed-pipeline:lint'
    )
    expect(managedCatalogPipelineId('repo-abc:managed-pipeline:lint')).toBe(
      'repo-abc:managed-pipeline:lint'
    )
  })

  it('preserves unscoped slot prefixes when no repo scope is present', () => {
    expect(managedCatalogPipelineId('pipeline:lint')).toBe('managed-pipeline:lint')
    expect(managedCatalogPipelineId('mcp-pipeline:full')).toBe('managed-pipeline:full')
  })

  it('rejects bare catalog ids and unrelated runtime ids', () => {
    expect(managedCatalogPipelineId('lint')).toBeUndefined()
    expect(managedCatalogPipelineId('repo-abc:agent:1')).toBeUndefined()
  })
})
