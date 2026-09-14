import { describe, expect, it } from 'vitest'
import { defaultSettings, sanitizeSettings, withAgentModel } from './settings'

describe('sanitizeSettings', () => {
  it('keeps a per-agent model map and drops unknown providers', () => {
    const s = sanitizeSettings({
      agent: 'cursor',
      models: { claude: 'opus', cursor: ' grok-4.6 ', nope: 'x', codex: '' },
      autoFix: false
    })
    expect(s).toEqual({ agent: 'cursor', models: { claude: 'opus', cursor: 'grok-4.6' }, autoFix: false })
  })

  it('migrates the pre-1.5.61 single `model` onto the saved agent', () => {
    const s = sanitizeSettings({ agent: 'codex', model: 'gpt-5.6-sol', autoFix: true })
    expect(s.models).toEqual({ codex: 'gpt-5.6-sol' })
  })

  it('prefers an explicit map entry over the legacy field', () => {
    const s = sanitizeSettings({ agent: 'claude', model: 'haiku', models: { claude: 'opus' } })
    expect(s.models.claude).toBe('opus')
  })

  it('drops a blank model so the CLI default applies', () => {
    expect(sanitizeSettings({ agent: 'cursor', autoFix: true, model: '  ' })).toEqual({
      agent: 'cursor',
      models: {},
      autoFix: true
    })
  })

  it('falls back to defaults for junk input', () => {
    expect(sanitizeSettings(null)).toEqual(defaultSettings())
    expect(sanitizeSettings({ agent: 'nope', models: 'nope', autoFix: 'yes' })).toEqual(
      defaultSettings()
    )
  })

  it('keeps OpenRouter pins and catalog, never a hasKey flag', () => {
    expect(
      sanitizeSettings({
        agent: 'openrouter',
        autoFix: true,
        openrouter: {
          hasKey: true,
          autoPinned: true,
          pinned: ['openai/gpt-4o', 'openai/gpt-4o'],
          catalog: [{ id: 'openai/gpt-4o', label: 'GPT-4o' }]
        }
      })
    ).toEqual({
      agent: 'openrouter',
      models: {},
      autoFix: true,
      openrouter: {
        autoPinned: true,
        pinned: ['openai/gpt-4o'],
        catalog: [{ id: 'openai/gpt-4o', label: 'GPT-4o' }]
      }
    })
  })
})

describe('withAgentModel', () => {
  it('sets one agent without touching the others', () => {
    const base = sanitizeSettings({ agent: 'claude', models: { claude: 'opus', omp: 'gemini-3-pro' } })
    expect(withAgentModel(base, 'cursor', 'composer-2.5').models).toEqual({
      claude: 'opus',
      omp: 'gemini-3-pro',
      cursor: 'composer-2.5'
    })
  })

  it('clears the entry when no model is given, so the CLI default applies', () => {
    const base = sanitizeSettings({ agent: 'claude', models: { claude: 'opus' } })
    expect(withAgentModel(base, 'claude').models).toEqual({})
    expect(withAgentModel(base, 'claude', '  ').models).toEqual({})
  })
})
