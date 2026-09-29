import { describe, expect, it } from 'vitest'
import {
  defaultSettings,
  modeDefault,
  modeFallbacks,
  modeSelectionForPane,
  sanitizeSettings,
  withRemoteKeyFlag,
  withAgentModel,
  withCommitMessageModel,
  withModeChain
} from './settings'

describe('sanitizeSettings', () => {
  it('keeps a per-agent model map and drops unknown providers', () => {
    const s = sanitizeSettings({
      agent: 'cursor',
      models: { claude: 'opus', cursor: ' grok-4.6 ', nope: 'x', codex: '' },
      autoFix: false
    })
    expect(s).toEqual({
      agent: 'cursor',
      models: { claude: 'opus', cursor: 'grok-4.6' },
      commitMessage: { agent: 'cursor', model: 'grok-4.6' },
      autoFix: false,
      modeDefaults: { plan: [], build: [] }
    })
  })

  it('migrates the pre-1.5.61 single `model` onto the saved agent', () => {
    const s = sanitizeSettings({ agent: 'codex', model: 'gpt-5.6-sol', autoFix: true })
    expect(s.models).toEqual({ codex: 'gpt-5.6-sol' })
    expect(s.commitMessage).toEqual({ agent: 'codex', model: 'gpt-5.6-sol' })
  })

  it('prefers an explicit map entry over the legacy field', () => {
    const s = sanitizeSettings({ agent: 'claude', model: 'haiku', models: { claude: 'opus' } })
    expect(s.models.claude).toBe('opus')
  })

  it('drops a blank model so the CLI default applies', () => {
    expect(sanitizeSettings({ agent: 'cursor', autoFix: true, model: '  ' })).toEqual({
      agent: 'cursor',
      models: {},
      commitMessage: { agent: 'cursor' },
      autoFix: true,
      modeDefaults: { plan: [], build: [] }
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
      commitMessage: { agent: 'openrouter' },
      autoFix: true,
      modeDefaults: { plan: [], build: [] },
      openrouter: {
        autoPinned: true,
        pinned: ['openai/gpt-4o'],
        catalog: [{ id: 'openai/gpt-4o', label: 'GPT-4o' }]
      }
    })
  })
})

describe('commit message selection', () => {
  it('persists independently from the chat agent and model defaults', () => {
    const base = sanitizeSettings({ agent: 'claude', models: { claude: 'opus' }, autoFix: true })
    expect(withCommitMessageModel(base, 'codex', 'gpt-5.6-sol')).toMatchObject({
      agent: 'claude',
      models: { claude: 'opus' },
      commitMessage: { agent: 'codex', model: 'gpt-5.6-sol' }
    })
  })

  it('keeps a full OpenRouter catalog and pins after settings migration', () => {
    const settings = sanitizeSettings({
      agent: 'claude',
      autoFix: true,
      openrouter: {
        autoPinned: true,
        pinned: ['openai/gpt-4o'],
        catalog: [
          { id: 'openai/gpt-4o', label: 'GPT-4o' },
          { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' }
        ]
      }
    })
    expect(settings.openrouter).toMatchObject({
      pinned: ['openai/gpt-4o'],
      catalog: [
        { id: 'openai/gpt-4o', label: 'GPT-4o' },
        { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' }
      ]
    })
  })

  it('keeps discovered per-agent catalogs', () => {
    const settings = sanitizeSettings({
      agent: 'codex',
      catalogs: {
        codex: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }],
        cursor: [{ id: 'auto', label: 'Auto' }],
        openrouter: [{ id: 'ignored', label: 'Ignored' }]
      }
    })
    expect(settings.catalogs).toEqual({
      codex: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }],
      cursor: [{ id: 'auto', label: 'Auto' }]
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

describe('mode defaults', () => {
  const base = sanitizeSettings({ agent: 'claude', models: { claude: 'opus' } })

  it('keeps the chain in order and drops rungs it cannot honour', () => {
    const s = sanitizeSettings({
      agent: 'claude',
      modeDefaults: {
        build: [
          { agent: 'codex', model: ' gpt-5.6-sol ' },
          { agent: 'nope', model: 'x' },
          { agent: 'codex', model: 'gpt-5.6-sol' },
          { agent: 'claude' }
        ],
        // Plan needs a review gate; Claude and OpenCode cannot enforce read-only.
        plan: [{ agent: 'claude' }, { agent: 'cursor', model: 'composer-2.5' }, { agent: 'omp' }]
      }
    })
    expect(s.modeDefaults.build).toEqual([
      { agent: 'codex', model: 'gpt-5.6-sol' },
      { agent: 'claude' }
    ])
    expect(s.modeDefaults.plan).toEqual([{ agent: 'cursor', model: 'composer-2.5' }, { agent: 'omp' }])
  })

  it('opens a mode on its first rung, or the plain agent default without one', () => {
    expect(modeDefault(base, 'build')).toEqual({ agent: 'claude', model: 'opus' })
    const chained = withModeChain(base, 'build', [{ agent: 'omp' }, { agent: 'codex' }])
    expect(modeDefault(chained, 'build')).toEqual({ agent: 'omp' })
    // The other mode is untouched.
    expect(modeDefault(chained, 'plan')).toEqual({ agent: 'claude', model: 'opus' })
  })

  it('falls back only down the rest of the chain', () => {
    const s = withModeChain(base, 'build', [
      { agent: 'omp' },
      { agent: 'codex', model: 'gpt-5.6-sol' },
      { agent: 'claude' }
    ])
    expect(modeFallbacks(s, 'build', 'omp')).toEqual([
      { agent: 'codex', model: 'gpt-5.6-sol' },
      { agent: 'claude' }
    ])
    expect(modeFallbacks(s, 'build', 'claude')).toEqual([])
    // A pick outside the chain has consumed none of it.
    expect(modeFallbacks(s, 'build', 'cursor', 'composer-2.5')).toHaveLength(3)
    // No chain configured means no fallback at all.
    expect(modeFallbacks(base, 'build', 'claude', 'opus')).toEqual([])
  })

  it('switches a live pane onto the mode chain head, else keeps its selection', () => {
    const pane = { provider: 'codex' as const, model: 'gpt-plan' }
    const chained = withModeChain(base, 'build', [{ agent: 'cursor', model: 'composer-2.5' }])
    expect(modeSelectionForPane(chained, 'build', pane)).toEqual({
      mode: 'build',
      provider: 'cursor',
      model: 'composer-2.5'
    })
    // No Build chain → keep whatever Plan was using.
    expect(modeSelectionForPane(base, 'build', pane)).toEqual({
      mode: 'build',
      provider: 'codex',
      model: 'gpt-plan'
    })
  })
})

describe('Remote service settings', () => {
  it('keeps the origin of a valid http(s) url and drops anything else', () => {
    expect(sanitizeSettings({ remote: { url: ' https://farol.up.railway.app/v1 ', key: 'x' } }).remote).toEqual({
      url: 'https://farol.up.railway.app'
    })
    expect(sanitizeSettings({ remote: { url: 'ftp://farol.dev' } }).remote).toBeUndefined()
    expect(sanitizeSettings({ remote: { url: 'nope' } }).remote).toBeUndefined()
  })

  it('flags a stored key only when a url exists', () => {
    const withUrl = sanitizeSettings({ remote: { url: 'http://localhost:8787' } })
    expect(withRemoteKeyFlag(withUrl, true).remote?.hasKey).toBe(true)
    expect(withRemoteKeyFlag(defaultSettings(), true).remote).toBeUndefined()
  })
})
