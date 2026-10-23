import { describe, expect, it } from 'vitest'
import { applyOpencodeConfig, opencodeConfigContent, opencodeRunConfig } from './opencode-config'

describe('opencode run config', () => {
  it('denies shell in Plan and adds nothing in Build', () => {
    expect(opencodeRunConfig('plan')).toEqual({ agent: { plan: { permission: { bash: 'deny' } } } })
    expect(opencodeRunConfig('build')).toBeUndefined()
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

  it('replaces a developer’s per-command bash rules for plan with a flat deny', () => {
    const env: Record<string, string | undefined> = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { plan: { model: 'x/y', permission: { bash: { 'git *': 'allow' } } } } })
    }
    applyOpencodeConfig(env, opencodeRunConfig('plan'))
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '')).toEqual({
      agent: { plan: { model: 'x/y', permission: { bash: 'deny' } } }
    })
  })

  it('leaves the env alone when there is no run config', () => {
    const env: Record<string, string | undefined> = { OPENCODE_CONFIG_CONTENT: '{"model":"x/y"}' }
    applyOpencodeConfig(env, undefined)
    expect(env).toEqual({ OPENCODE_CONFIG_CONTENT: '{"model":"x/y"}' })
  })
})
