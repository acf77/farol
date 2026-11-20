import { describe, expect, it } from 'vitest'
import {
  AI_PROVIDERS,
  aiCommand,
  aiFixCommand,
  aiSelectionLabel,
  canAskApproval,
  cliFor,
  effortSupported,
  interactiveAiCommand,
  isAiProvider,
  managedAiCommand,
  managedGitRefusal,
  managedToolRefusal,
  modelsFor,
  normalizeAi,
  normalizeEffort,
  normalizeModel,
  normalizeOpenRouterAgent,
  pickerProviders,
  providerModels,
  usesOpenRouterEnv,
  withModel
} from './ai'

/** The project `farol` server's tools that managed Claude must not call. */
const FAROL_TOOLS_OFF = [
  'mcp__farol__list_pipelines',
  'mcp__farol__run_pipeline',
  'mcp__farol__git_status',
  'mcp__farol__git_diff',
  'mcp__farol__git_log',
  'mcp__farol__git_show',
  'mcp__farol__git_commit',
  'mcp__farol__git_push',
  'mcp__farol__git_create_pr'
].join(',')

describe('normalizeAi', () => {
  it('keeps a known provider', () => {
    expect(normalizeAi('codex')).toBe('codex')
    expect(normalizeAi('cursor')).toBe('cursor')
    expect(normalizeAi('opencode')).toBe('opencode')
    expect(normalizeAi('openrouter')).toBe('openrouter')
    expect(normalizeAi('claude')).toBe('claude')
  })

  it('falls back to Claude for missing or unknown values', () => {
    expect(normalizeAi(undefined)).toBe('claude')
    expect(normalizeAi('gpt')).toBe('claude')
    expect(isAiProvider('agent')).toBe(false)
  })
})

describe('normalizeModel', () => {
  it('treats blank values as the CLI default', () => {
    expect(normalizeModel(undefined)).toBeUndefined()
    expect(normalizeModel('  ')).toBeUndefined()
    expect(normalizeModel('sonnet')).toBe('sonnet')
  })

  it('labels a stored id, including ones not in the catalog', () => {
    expect(aiSelectionLabel('claude', undefined)).toBe('Claude')
    expect(aiSelectionLabel('claude', 'sonnet')).toBe('Claude · Sonnet 5.5')
    expect(aiSelectionLabel('claude', 'custom-id')).toBe('Claude · custom-id')
    expect(aiSelectionLabel('cursor', undefined)).toBe('Cursor · Auto')
    expect(aiSelectionLabel('cursor', 'auto')).toBe('Cursor · Auto')
    expect(modelsFor('claude', 'custom-id').some((m) => m.id === 'custom-id')).toBe(true)
    expect(aiSelectionLabel('openrouter', undefined)).toBe('OpenRouter')
  })
})

describe('withModel', () => {
  it('inserts --model before the trailing prompt', () => {
    expect(withModel(['-p', 'review this'], 'sonnet')).toEqual(['-p', '--model', 'sonnet', 'review this'])
    expect(withModel(['-p', 'review this'], undefined)).toEqual(['-p', 'review this'])
  })
})

describe('aiCommand', () => {
  it('builds a non-interactive argv for each provider', () => {
    expect(aiCommand('claude', 'review this').args).toEqual(['-p', 'review this'])
    expect(aiCommand('codex', 'review this').args).toEqual([
      'exec',
      '-c',
      'approval_policy=never',
      '--sandbox',
      'read-only',
      'review this'
    ])
    expect(aiCommand('cursor', 'review this').args).toEqual([
      '-p',
      '--force',
      '--mode=ask',
      '--output-format',
      'text',
      'review this'
    ])
    // OpenCode's plan agent has no write tools; its shell is denied for the run.
    expect(aiCommand('opencode', 'review this').args).toEqual(['run', '--auto', '--agent', 'plan', 'review this'])
    expect(aiCommand('opencode', 'review this').opencodeConfig).toEqual({ agent: { plan: { permission: { bash: 'deny' } } } })
    expect(aiCommand('openrouter', 'review this').args).toEqual(['run', '--auto', '--agent', 'plan', 'review this'])
    // omp has no read-only sandbox flag, so the tool set enforces it.
    expect(aiCommand('omp', 'review this').args).toEqual([
      '-p',
      '--auto-approve',
      '--tools',
      'read,glob,grep,lsp',
      'review this'
    ])
  })

  it('passes --model through to each CLI', () => {
    expect(aiCommand('claude', 'review this', 'sonnet').args).toEqual([
      '-p',
      '--model',
      'sonnet',
      'review this'
    ])
    expect(aiCommand('codex', 'review this', 'gpt-5.6-terra').args).toContain('--model')
    expect(aiCommand('cursor', 'review this', 'composer-2.5').args).toEqual([
      '-p',
      '--force',
      '--mode=ask',
      '--output-format',
      'text',
      '--model',
      'composer-2.5',
      'review this'
    ])
    expect(aiCommand('cursor', 'review this', 'auto').args).toEqual([
      '-p',
      '--force',
      '--mode=ask',
      '--output-format',
      'text',
      '--model',
      'auto',
      'review this'
    ])
  })

  it('tries Cursor as agent, then cursor-agent', () => {
    expect(aiCommand('cursor', 'x').bins).toEqual(['agent', 'cursor-agent'])
  })
})

describe('managedAiCommand', () => {
  it('refuses providers without a native execution barrier in every launch mode', () => {
    for (const provider of AI_PROVIDERS.filter((provider) => provider !== 'claude')) {
      for (const mode of ['build', 'plan'] as const) {
        expect(() => managedAiCommand(provider, 'run git', undefined, {
          mode, resume: 'old-session', askApproval: true, tools: ['Bash']
        })).toThrow('cannot enforce the Git action limit')
      }
    }
    expect(managedGitRefusal('claude')).toBeUndefined()
  })

  it('keeps restricted mode, fixed tools, and a closed MCP config on fresh and resumed runs', () => {
    for (const resume of [undefined, 'old-session']) {
      const args = managedAiCommand('claude', 'fix this', 'opus', { resume }).args
      expect(args).toContain('--restricted')
      expect(args).toContain('--strict-mcp-config')
      expect(args).toContain('--disable-slash-commands')
      expect(args).toContain('--no-chrome')
      expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true })
      expect(JSON.parse(args[args.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: {} })
      expect(args[args.indexOf('--disallowedTools') + 1]).toBe(FAROL_TOOLS_OFF)
      expect(args).not.toContain('bypassPermissions')
      const tools = args[args.indexOf('--tools') + 1].split(',')
      expect(tools).toContain('Read')
      expect(tools).toContain('Edit')
      expect(tools).not.toContain('Bash')
      expect(tools).not.toContain('Agent')
      expect(args.slice(-3)).toEqual(['--model', 'opus', 'fix this'])
      expect(args.includes('--resume')).toBe(!!resume)
    }
  })

  it('intersects caller tools with the execution limit, including empty and Plan lists', () => {
    const forbidden = ['Bash', 'PowerShell', 'python', 'browser', 'Agent', 'Task', 'Skill', 'mcp__external__exec']
    for (const mode of ['build', 'plan'] as const) {
      const args = managedAiCommand('claude', 'x', undefined, {
        mode, tools: ['Read', 'Write', ...forbidden]
      }).args
      expect(args[args.indexOf('--tools') + 1]).toBe(mode === 'plan' ? 'Read' : 'Read,Write')
    }
    const empty = managedAiCommand('claude', 'x', undefined, { tools: [] }).args
    expect(empty[empty.indexOf('--tools') + 1]).toBe('')
  })

  it('loads only the host managed server and keeps Ask first within the same limit', () => {
    const mcp = { command: '/app/Farol', args: ['/app/mcp.js'] }
    for (const askApproval of [true, false]) {
      const args = managedAiCommand('claude', 'x', undefined, { mcp, askApproval }).args
      expect(JSON.parse(args[args.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: { 'farol-chat': mcp } })
      expect(args[args.indexOf('--permission-mode') + 1]).toBe(askApproval ? 'default' : 'dontAsk')
      expect(args).toContain('--restricted')
      expect(args.includes('--permission-prompt-tool')).toBe(askApproval)
      expect(args.indexOf('--permission-mode')).toBeGreaterThan(args.indexOf('--allowedTools'))
      expect(args.at(-1)).toBe('x')
    }
    const plan = managedAiCommand('claude', 'x', undefined, { mcp, askApproval: true, mode: 'plan' }).args
    expect(plan[plan.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(plan[plan.indexOf('--tools') + 1]).not.toContain('Write')
    expect(plan).not.toContain('--permission-prompt-tool')
  })

  it('cannot grant command or custom tools through a permission answer', () => {
    for (const name of ['Bash', 'shell', 'python', 'Agent', 'Task', 'mcp__external__exec']) {
      expect(managedToolRefusal(name, { command: 'git status' })).toBeDefined()
    }
    expect(managedToolRefusal('Write', { file_path: '.git/config' })).toBeDefined()
    expect(managedToolRefusal('Write', { file_path: 'app.ts' }, 'plan')).toBeDefined()
    expect(managedToolRefusal('Write', { file_path: 'app.ts' }, 'build')).toBeUndefined()
    expect(managedToolRefusal('Read', {})).toBeUndefined()
  })

  it('offers approval only for the supported managed provider', () => {
    for (const provider of AI_PROVIDERS) expect(canAskApproval(provider)).toBe(provider === 'claude')
  })

  it('keeps model, effort, resume, and stream output on supported launches', () => {
    const spec = managedAiCommand('claude', 'next', 'opus', { effort: 'high', resume: 's1' })
    expect(spec.args.slice(-5)).toEqual(['--resume', 's1', '--model', 'opus', 'next'])
    expect(spec.args[spec.args.indexOf('--effort') + 1]).toBe('high')
    expect(spec.stream).toBe('ndjson')
    expect(canAskApproval('claude')).toBe(true)
    expect(effortSupported('claude')).toBe(true)
    expect(normalizeEffort('ultra')).toBeUndefined()
  })

  it('runs OpenRouter through OpenCode with a prefixed --model', () => {
    expect(cliFor('openrouter')).toBe('opencode')
    expect(usesOpenRouterEnv('openrouter')).toBe(true)
    expect(usesOpenRouterEnv('opencode')).toBe(true)
    expect(usesOpenRouterEnv('claude')).toBe(false)
    expect(aiCommand('openrouter', 'review this', 'anthropic/claude-sonnet-4').args).toEqual([
      'run',
      '--auto',
      '--agent',
      'plan',
      '--model',
      'openrouter/anthropic/claude-sonnet-4',
      'review this'
    ])
    expect(interactiveAiCommand('openrouter')).toBe('opencode')
  })

  it('runs OpenRouter through upstream pi when chosen, with the same prefixed --model', () => {
    expect(normalizeOpenRouterAgent('pi')).toBe('pi')
    expect(normalizeOpenRouterAgent(undefined)).toBe('opencode')
    expect(normalizeOpenRouterAgent('omp')).toBe('opencode')
    expect(cliFor('openrouter', 'pi')).toBe('pi')
    expect(cliFor('claude', 'pi')).toBe('claude')
    const oneShot = aiCommand('openrouter', 'review this', 'anthropic/claude-sonnet-4', 'pi')
    expect(oneShot.bins).toEqual(['pi'])
    expect(oneShot.args).toEqual([
      '-p',
      '--tools',
      'read,grep,find,ls',
      '--model',
      'openrouter/anthropic/claude-sonnet-4',
      'review this'
    ])
    expect(interactiveAiCommand('openrouter', 'pi')).toBe('pi')
    expect(aiFixCommand('openrouter', undefined, 'pi')).toMatch(/^pi "/)
    // The choice only reroutes OpenRouter; plain OpenCode stays OpenCode.
    expect(cliFor('opencode', 'pi')).toBe('opencode')
  })

  it('shows OpenRouter after a key and catalog exist, listing only its pins', () => {
    expect(pickerProviders().includes('openrouter')).toBe(false)
    expect(pickerProviders({ hasKey: true, pinned: [] }).includes('openrouter')).toBe(false)
    expect(pickerProviders({ hasKey: true, pinned: ['openai/gpt-4o'] }).includes('openrouter')).toBe(
      true
    )
    expect(
      pickerProviders({ hasKey: true, pinned: [], catalog: [{ id: 'openai/gpt-4o', label: 'GPT-4o' }] })
    ).toContain('openrouter')
    const catalog = [
      { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
      { id: 'openai/gpt-4o', label: 'GPT-4o' }
    ]
    expect(
      providerModels('openrouter', undefined, {
        openrouter: { pinned: ['openai/gpt-4o'], catalog }
      }).map((model) => model.id)
    ).toEqual(['openai/gpt-4o'])
    // Nothing pinned yet — the whole catalog, so the menu is never empty.
    expect(
      providerModels('openrouter', undefined, { openrouter: { pinned: [], catalog } }).map(
        (model) => model.id
      )
    ).toEqual(['anthropic/claude-sonnet-4', 'openai/gpt-4o'])
    // An unpinned id already in use stays selectable.
    expect(
      providerModels('openrouter', 'anthropic/claude-sonnet-4', {
        openrouter: { pinned: ['openai/gpt-4o'], catalog }
      }).map((model) => model.id)
    ).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
  })

  it('prefers a discovered catalog over the built-in fallback list', () => {
    expect(
      providerModels('codex', undefined, {
        catalogs: { codex: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }] }
      }).map((m) => m.id)
    ).toEqual(['gpt-6-astra'])
    expect(
      providerModels('claude', undefined, {
        catalogs: { claude: [{ id: 'fable', label: 'Fable 5.1' }, { id: 'opus', label: 'Opus 5' }] }
      }).map((m) => m.id)
    ).toEqual(['fable', 'opus'])
  })

})

describe('omp', () => {
  it('is its own CLI, offered in the picker without any extra setup', () => {
    expect(cliFor('omp')).toBe('omp')
    expect(usesOpenRouterEnv('omp')).toBe(false)
    expect(pickerProviders()).toContain('omp')
    expect(AI_PROVIDERS).toContain('omp')
  })

  it('takes the prompt directly, interactively and headless', () => {
    expect(interactiveAiCommand('omp')).toBe('omp')
    expect(aiFixCommand('omp', 'REPORT.md')).toContain('omp "')
    expect(() => managedAiCommand('omp', 'fix this')).toThrow('cannot enforce the Git action limit')
  })
})
