import { describe, expect, it } from 'vitest'
import {
  defaultSettings,
  modeDefault,
  modeFallbacks,
  modeSelectionForPane,
  retainCatalogs,
  sanitizeSettings,
  withAgentModel,
  withCommitMessageModel,
  withModeChain,
  withOpenRouterAgent
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

  it('keeps the OpenRouter agent choice and stores OpenCode as absence', () => {
    expect(sanitizeSettings({ openrouter: { agent: 'omp' } }).openrouter).toEqual({
      pinned: [],
      catalog: [],
      autoPinned: false,
      agent: 'omp'
    })
    expect(sanitizeSettings({ openrouter: { agent: 'opencode' } }).openrouter).toBeUndefined()
    expect(
      sanitizeSettings({ openrouter: { agent: 'bogus', pinned: ['openai/gpt-4o'] } }).openrouter
    ).not.toHaveProperty('agent')

    const omp = withOpenRouterAgent(defaultSettings(), 'omp')
    expect(omp.openrouter?.agent).toBe('omp')
    expect(withOpenRouterAgent(omp, 'opencode').openrouter).not.toHaveProperty('agent')
  })

  it('keeps discovered per-agent catalogs', () => {
    const settings = sanitizeSettings({
      agent: 'codex',
      catalogs: {
        claude: [{ id: 'fable', label: 'Fable 5.1' }],
        codex: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }],
        cursor: [{ id: 'auto', label: 'Auto' }],
        openrouter: [{ id: 'ignored', label: 'Ignored' }]
      }
    })
    expect(settings.catalogs).toEqual({
      claude: [{ id: 'fable', label: 'Fable 5.1' }],
      codex: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }],
      cursor: [{ id: 'auto', label: 'Auto' }]
    })
  })
})

describe('retainCatalogs', () => {
  it('keeps persisted catalogs when a renderer save sends a stale or empty list', () => {
    const persisted = sanitizeSettings({
      agent: 'codex',
      catalogs: { codex: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }] }
    })
    const incoming = sanitizeSettings({
      agent: 'claude',
      catalogs: { codex: [{ id: 'gpt-5.5', label: 'GPT-5.5' }] }
    })
    expect(retainCatalogs(incoming, persisted).catalogs).toEqual(persisted.catalogs)
    expect(retainCatalogs(sanitizeSettings({ agent: 'claude' }), persisted).catalogs).toEqual(
      persisted.catalogs
    )
  })

  it('does not let a renderer save invent catalogs', () => {
    const incoming = sanitizeSettings({
      agent: 'claude',
      catalogs: { claude: [{ id: 'fable', label: 'Fable 5.1' }] }
    })
    expect(retainCatalogs(incoming, sanitizeSettings({ agent: 'claude' })).catalogs).toBeUndefined()
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
        // OpenRouter rides OpenCode's read-only agent, so it keeps a Plan rung too.
        plan: [{ agent: 'claude' }, { agent: 'openrouter' }, { agent: 'omp' }]
      }
    })
    expect(s.modeDefaults.build).toEqual([
      { agent: 'codex', model: 'gpt-5.6-sol' },
      { agent: 'claude' }
    ])
    expect(s.modeDefaults.plan).toEqual([
      { agent: 'claude' },
      { agent: 'openrouter' },
      { agent: 'omp' }
    ])
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
