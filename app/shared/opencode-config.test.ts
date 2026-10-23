import { describe, expect, it } from 'vitest'
import { opencodeConfigContent, opencodeRunConfig } from './opencode-config'

describe('opencode run config', () => {
  it('denies shell in Plan, whatever else is asked', () => {
    expect(opencodeRunConfig('plan', false)).toEqual({ agent: { plan: { permission: { bash: 'deny' } } } })
    expect(opencodeRunConfig('plan', true)).toEqual({ agent: { plan: { permission: { bash: 'deny' } } } })
  })

  it('makes edits, shell and fetches ask in Build when asking first, and adds nothing otherwise', () => {
    expect(opencodeRunConfig('build', true)).toEqual({ permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' } })
    expect(opencodeRunConfig('build', false)).toBeUndefined()
  })

  it('merges over the developer’s own config content, Farol’s rules winning', () => {
    const existing = JSON.stringify({ model: 'x/y', permission: { bash: 'allow', read: 'allow' } })
    expect(JSON.parse(opencodeConfigContent(existing, { permission: { bash: 'ask' } }))).toEqual({
      model: 'x/y',
      permission: { bash: 'ask', read: 'allow' }
    })
    expect(JSON.parse(opencodeConfigContent('not json', { a: 1 }))).toEqual({ a: 1 })
    expect(JSON.parse(opencodeConfigContent(undefined, { a: 1 }))).toEqual({ a: 1 })
  })
})
