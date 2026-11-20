/** Which coding CLI an AI pipeline step invokes. */

import { FAILURE_REPORT_REL } from './failure'
import { opencodeRunConfig } from './opencode-config'
import { openCodeModel } from './openrouter'
import {
  APPROVE_TOOL,
  claudeMcpConfig,
  DELEGATE_TOOL,
  GIT_MCP_TOOLS,
  PIPELINE_MCP_TOOLS,
  type McpServerEntry
} from './mcp-config'

export const AI_PROVIDERS = ['claude', 'codex', 'cursor', 'opencode', 'omp', 'openrouter'] as const
export type AiProvider = (typeof AI_PROVIDERS)[number]
export type AgentMode = 'plan' | 'build'
/**
 * The binary Farol actually spawns. OpenRouter rides OpenCode or upstream pi
 * (`@mariozechner/pi-coding-agent`), which is not a provider of its own.
 */
export type AiCli = Exclude<AiProvider, 'openrouter'> | 'pi'

/** CLIs that can carry OpenRouter; both read `OPENROUTER_API_KEY` and take `openrouter/<slug>`. */
export const OPENROUTER_AGENTS = ['opencode', 'pi'] as const
export type OpenRouterAgent = (typeof OPENROUTER_AGENTS)[number]

export const OPENROUTER_AGENT_LABELS: Record<OpenRouterAgent, string> = {
  opencode: 'OpenCode',
  pi: 'Pi'
}

/** Older settings have no choice stored; they keep running OpenCode. */
export function normalizeOpenRouterAgent(value: unknown): OpenRouterAgent {
  return value === 'pi' ? 'pi' : 'opencode'
}

export const AI_LABELS: Record<AiProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  omp: 'OMP',
  openrouter: 'OpenRouter'
}

/** Models each CLI accepts via `--model`. Ids are what the binary takes. */
export interface AiModel {
  id: string
  label: string
  /** Input context window in tokens, when the provider reports one. */
  contextWindow?: number
}

/**
 * Built-in fallback lists used when a live catalog has not been discovered yet
 * (CLI missing, empty cache, or Claude — which has no machine-readable list).
 */
export const AI_MODELS: Record<AiProvider, readonly AiModel[]> = {
  claude: [
    { id: 'sonnet', label: 'Sonnet 5.5' },
    { id: 'opus', label: 'Opus 5.5' },
    { id: 'fable', label: 'Fable 5.1' },
    { id: 'haiku', label: 'Haiku 5.5' }
  ],
  codex: [
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-5.6', label: 'GPT-5.6' },
    { id: 'gpt-5.5', label: 'GPT-5.5' }
  ],
  cursor: [
    { id: 'auto', label: 'Auto' },
    { id: 'composer-2.5', label: 'Composer 2.5' },
    { id: 'gpt-5.6', label: 'GPT-5.6' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
    { id: 'gemini-3-pro', label: 'Gemini 3 Pro' },
    { id: 'grok-4.6', label: 'Grok 4.6' },
    { id: 'gpt-5.5', label: 'GPT-5.5' }
  ],
  opencode: [
    { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5' },
    { id: 'openai/gpt-5.6', label: 'GPT-5.6' },
    { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
    { id: 'google/gemini-3-pro', label: 'Gemini 3 Pro' },
    { id: 'google/gemini-3-flash', label: 'Gemini 3 Flash' },
    { id: 'x-ai/grok-4.6', label: 'Grok 4.6' }
  ],
  /** `--model` fuzzy-matches, but exact catalog ids avoid an ambiguous pick. */
  omp: [
    { id: 'claude-opus-5-medium', label: 'Claude Opus 5' },
    { id: 'claude-sonnet-5-medium', label: 'Claude Sonnet 5' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gemini-3-pro', label: 'Gemini 3 Pro' },
    { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
    { id: 'composer-2.5', label: 'Composer 2.5' },
    { id: 'grok-4.6', label: 'Grok 4.6' }
  ],
  /** Filled from the user's OpenRouter pins (or its whole catalog, unpinned). */
  openrouter: []
}

/** Only the supported managed provider can ask through Farol's permission tool. */
export function canAskApproval(provider: AiProvider): boolean {
  return provider === 'claude'
}

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value)
}

export function cliFor(provider: AiProvider, via: OpenRouterAgent = 'opencode'): AiCli {
  return provider === 'openrouter' ? via : provider
}

/** Direct vendor keys Farol can hold; each feeds the env var its CLI reads. */
export const PROVIDER_KEYS = ['anthropic', 'openai'] as const
export type ProviderKey = (typeof PROVIDER_KEYS)[number]

export function isProviderKey(value: unknown): value is ProviderKey {
  return (PROVIDER_KEYS as readonly unknown[]).includes(value)
}

export const PROVIDER_KEY_ENV: Partial<Record<AiProvider, { key: ProviderKey; env: string[] }>> = {
  claude: { key: 'anthropic', env: ['ANTHROPIC_API_KEY'] },
  codex: { key: 'openai', env: ['OPENAI_API_KEY', 'CODEX_API_KEY'] }
}

export function usesOpenRouterEnv(provider: AiProvider): boolean {
  return provider === 'openrouter' || provider === 'opencode'
}

/** Any value other than `'plan'` normalizes to Build. */
export function normalizeMode(mode: AgentMode | undefined): AgentMode {
  return mode === 'plan' ? 'plan' : 'build'
}

/** Older pipelines omit `ai`; they keep running Claude. */
export function normalizeAi(value: unknown): AiProvider {
  return isAiProvider(value) ? value : 'claude'
}

/** Empty or non-string values mean "use the CLI's own default". */
export function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const id = value.trim()
  return id || undefined
}

export function aiModelLabel(
  provider: AiProvider,
  model?: string,
  listed?: readonly AiModel[]
): string | undefined {
  const id = normalizeModel(model)
  // Cursor's CLI default is Auto; show it even when the model id was omitted.
  if (!id) return provider === 'cursor' ? 'Auto' : undefined
  return (listed?.length ? listed : AI_MODELS[provider]).find((m) => m.id === id)?.label ?? id
}

/** `Claude` or `Claude · Sonnet 5`. */
export function aiSelectionLabel(
  provider: AiProvider,
  model?: string,
  listed?: readonly AiModel[]
): string {
  const cli = AI_LABELS[provider]
  const label = aiModelLabel(provider, model, listed)
  return label ? `${cli} · ${label}` : cli
}

/** Models offered in the picker, plus a stored custom id so it stays selectable. */
export function modelsFor(
  provider: AiProvider,
  current?: string,
  listed?: readonly AiModel[]
): readonly AiModel[] {
  const base = listed?.length ? listed : AI_MODELS[provider]
  const id = normalizeModel(current)
  if (id && !base.some((m) => m.id === id)) return [...base, { id, label: id }]
  return base
}

/** OpenRouter appears after a key is saved and it has at least one known model. */
export function pickerProviders(openrouter?: {
  hasKey?: boolean
  pinned: string[]
  catalog?: readonly AiModel[]
}): readonly AiProvider[] {
  if (openrouter?.hasKey && (openrouter.pinned.length || openrouter.catalog?.length)) return AI_PROVIDERS
  return AI_PROVIDERS.filter((p) => p !== 'openrouter')
}

/**
 * Pins are the whole OpenRouter list once there is at least one — the catalog
 * runs to hundreds of ids, and pinning is how the user narrows it. With
 * nothing pinned the full catalog shows, so the menu is never empty.
 */
export function openrouterModels(
  catalog: readonly AiModel[],
  pinned: readonly string[],
  current?: string
): readonly AiModel[] {
  const byId = new Map(catalog.map((m) => [m.id, m]))
  const listed = pinned.length ? pinned.map((id) => byId.get(id) ?? { id, label: id }) : catalog
  return modelsFor('openrouter', current, listed)
}

/** Picker options for one provider — live catalogs when present, else built-ins. */
export function providerModels(
  provider: AiProvider,
  current?: string,
  settings?: {
    openrouter?: { catalog: readonly AiModel[]; pinned: readonly string[] }
    catalogs?: Partial<Record<AiProvider, readonly AiModel[]>>
  }
): readonly AiModel[] {
  return provider === 'openrouter'
    ? openrouterModels(
        settings?.openrouter?.catalog ?? [],
        settings?.openrouter?.pinned ?? [],
        current
      )
    : modelsFor(provider, current, settings?.catalogs?.[provider])
}

/** How hard the agent thinks. Omitted means the CLI's own default. */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'max'] as const
export type AgentEffort = (typeof AGENT_EFFORTS)[number]

export const AGENT_EFFORT_LABELS: Record<AgentEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max'
}

export function normalizeEffort(value: unknown): AgentEffort | undefined {
  return (AGENT_EFFORTS as readonly unknown[]).includes(value) ? (value as AgentEffort) : undefined
}

/**
 * Flags checked with `claude --help` (`--effort`), `codex exec -c` (`model_reasoning_effort`)
 * and `omp --help` (`--thinking`). The other CLIs have no flag Farol can rely on.
 */
export function effortSupported(provider: AiProvider, via?: OpenRouterAgent): boolean {
  const cli = cliFor(provider, via)
  return cli === 'claude' || cli === 'codex' || cli === 'omp'
}

/** argv fragment that sets the effort, or empty when there is none or the CLI has no such flag. */
export function effortArgv(cli: AiCli, effort: AgentEffort | undefined): string[] {
  if (!effort) return []
  switch (cli) {
    case 'claude':
      return ['--effort', effort]
    case 'codex':
      // Codex's top level is `xhigh`.
      return ['-c', `model_reasoning_effort="${effort === 'max' ? 'xhigh' : effort}"`]
    case 'omp':
      return ['--thinking', effort]
    default:
      return []
  }
}

/** Insert `--model <id>` before the trailing prompt. */
export function withModel(args: string[], model?: string): string[] {
  const id = normalizeModel(model)
  if (!id) return args
  const prompt = args[args.length - 1]
  if (prompt === undefined) return ['--model', id]
  return [...args.slice(0, -1), '--model', id, prompt]
}

export interface AiCommand {
  /** Binaries to try, in order — Cursor ships as `agent` or `cursor-agent`. */
  bins: string[]
  args: string[]
  /** Shown when none of `bins` is on PATH. */
  hint: string
  /**
   * `ndjson` means stdout is one JSON event per line, parsed by
   * `shared/agent-stream.ts`. Absent means stdout is plain text to show as-is.
   */
  stream?: 'ndjson'
  /** OpenCode settings for this run only, merged into `OPENCODE_CONFIG_CONTENT` (see `opencode-config.ts`). */
  opencodeConfig?: Record<string, unknown>
}

/** `--flag <id>` to continue the CLI's own saved conversation, or empty for a new one. */
function resumeArgv(flag: string, resume: string | undefined): string[] {
  return resume ? [flag, resume] : []
}

/** OMP has no read-only sandbox, so this allowlist — inspection only, no bash/edit/write — is the gate. */
const OMP_READONLY_TOOLS = 'read,glob,grep,lsp'
/** Pi has no sandbox or approval prompts either; its gate is the same kind of allowlist. */
const PI_READONLY_TOOLS = 'read,grep,find,ls'
const PI_HINT = 'Install pi (npm i -g @mariozechner/pi-coding-agent) to run OpenRouter through Pi.'

/**
 * Non-interactive argv for each CLI. Cursor runs in ask mode with plain
 * text so a review step returns a string instead of Agent "ACT" chrome.
 * `--force` still auto-approves read tools so it cannot stall on a prompt.
 */
export function aiCommand(
  provider: AiProvider,
  prompt: string,
  model?: string,
  via?: OpenRouterAgent
): AiCommand {
  const cli = cliFor(provider, via)
  const passed = provider === 'openrouter' ? openCodeModel(model) : model
  switch (cli) {
    case 'codex':
      return {
        bins: ['codex'],
        // Force approval_policy=never via -c: --sandbox alone does not override a
        // user config that still asks for approval, which would hang headless reviews.
        args: withModel(
          ['exec', '-c', 'approval_policy=never', '--sandbox', 'read-only', prompt],
          passed
        ),
        hint: "Install the Codex CLI (npm i -g @openai/codex) to run Codex steps."
      }
    case 'cursor':
      return {
        bins: ['agent', 'cursor-agent'],
        args: withModel(['-p', '--force', '--mode=ask', '--output-format', 'text', prompt], passed),
        hint: 'Install the Cursor CLI (https://cursor.com/docs/cli) to run Cursor steps.'
      }
    case 'opencode':
      return {
        bins: ['opencode'],
        // Read-only like every other CLI here: the plan agent has no write
        // tools, and its shell is denied for the run (`--auto` would approve an `ask`).
        args: withModel(['run', '--auto', '--agent', 'plan', prompt], passed),
        hint: 'Install the OpenCode CLI (https://opencode.ai) to run OpenCode steps.',
        opencodeConfig: opencodeRunConfig('plan', false)
      }
    case 'omp':
      return {
        bins: ['omp'],
        // --auto-approve keeps it from waiting on an approval it can never receive.
        args: withModel(['-p', '--auto-approve', '--tools', OMP_READONLY_TOOLS, prompt], passed),
        hint: 'Install oh-my-pi (npm i -g @oh-my-pi/pi-coding-agent) to run OMP steps.'
      }
    case 'pi':
      return {
        bins: ['pi'],
        // Pi never asks for approval, so no auto-approve flag exists or is needed.
        args: withModel(['-p', '--tools', PI_READONLY_TOOLS, prompt], passed),
        hint: PI_HINT
      }
    case 'claude':
      return {
        bins: ['claude'],
        args: withModel(['-p', prompt], passed),
        hint: 'Install the Claude Code CLI (npm i -g @anthropic-ai/claude-code) to run Claude steps.'
      }
  }
}

function managedClaudeCommand(
  prompt: string,
  passed: string | undefined,
  plan: boolean,
  tools: string,
  resume?: string,
  mcp?: McpServerEntry,
  askApproval?: boolean,
  effort?: AgentEffort
): AiCommand {
  const ask = !!(askApproval && mcp && !plan)
  return {
    bins: ['claude'],
    // Restricted mode removes execution tools, confines file access, and protects Git metadata.
    // Unknown flags fail before the model runs on older CLIs. User MCP servers and hooks stay off.
    args: withModel(
      [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        ...effortArgv('claude', effort),
        '--restricted',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-chrome',
        '--settings',
        JSON.stringify({ disableAllHooks: true }),
        '--mcp-config',
        mcp ? claudeMcpConfig(mcp) : JSON.stringify({ mcpServers: {} }),
        '--disallowedTools',
        [...PIPELINE_MCP_TOOLS, ...GIT_MCP_TOOLS].join(','),
        '--allowedTools',
        ask ? DELEGATE_TOOL : `${tools},${DELEGATE_TOOL}`,
        ...(ask ? ['--permission-prompt-tool', APPROVE_TOOL] : []),
        '--permission-mode',
        plan ? 'plan' : ask ? 'default' : 'dontAsk',
        '--tools',
        tools,
        ...resumeArgv('--resume', resume),
        prompt
      ],
      passed
    ),
    hint: 'Install Claude Code (npm i -g @anthropic-ai/claude-code) to use managed Chat.',
    stream: 'ndjson'
  }
}

/** Only a provider with a native execution barrier may run in managed Chat. */
export function managedGitRefusal(provider: AiProvider): string | undefined {
  if (provider === 'claude') return undefined
  return `${AI_LABELS[provider]} cannot enforce the Git action limit. Select Claude with restricted mode support.`
}

/** Built-ins only: no shell, code interpreter, browser automation, or native subagents. */
const MANAGED_CLAUDE_TOOLS = {
  inspect: ['Read', 'Glob', 'Grep', 'AskUserQuestion'],
  edit: ['Edit', 'Write', 'NotebookEdit'],
  web: ['WebFetch', 'WebSearch']
}

/** The tool policy and launch ceiling use the same built-ins. */
export function managedClaudeTools(allowed: readonly ('edit' | 'web')[]): string[] {
  return [...MANAGED_CLAUDE_TOOLS.inspect, ...allowed.flatMap((family) => MANAGED_CLAUDE_TOOLS[family])]
}

/** A permission answer cannot restore execution or permit direct Git metadata writes. */
export function managedToolRefusal(name: string, input: unknown, mode?: AgentMode): string | undefined {
  const edit = MANAGED_CLAUDE_TOOLS.edit.includes(name)
  if (!managedClaudeTools(mode === 'plan' ? ['web'] : ['edit', 'web']).includes(name)) {
    return 'This tool is disabled. Use Farol actions for Git and pipelines for commands.'
  }
  if (edit) {
    const fields = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const file = fields.file_path ?? fields.notebook_path
    if (typeof file !== 'string' || /(^|[\\/])\.git([\\/]|$)/i.test(file)) {
      return 'Direct Git metadata writes are disabled. Use Farol Git actions.'
    }
  }
  return undefined
}

/** Every launch, including resume and delegates, applies the same execution barrier. */
export function managedAiCommand(
  provider: AiProvider,
  prompt: string,
  model?: string,
  opts?: {
    mode?: AgentMode
    tools?: string[]
    resume?: string
    /** Farol's only MCP server for this run. */
    mcp?: McpServerEntry
    /** Ask the developer before tool calls instead of approving them all (Claude, Build, with `mcp`). */
    askApproval?: boolean
    /** Thinking level for the supported managed CLI. */
    effort?: AgentEffort
  }
): AiCommand {
  const refusal = managedGitRefusal(provider)
  if (refusal) throw new Error(refusal)
  const { resume: resumeId, mode, tools: requested, mcp, askApproval, effort } = opts ?? {}
  const plan = mode === 'plan'
  const ceiling = managedClaudeTools(plan ? ['web'] : ['edit', 'web'])
  const tools = requested === undefined ? ceiling : ceiling.filter((tool) => requested.includes(tool))
  return managedClaudeCommand(prompt, model, plan, tools.join(','), resumeId?.trim() || undefined, mcp, askApproval, effort)
}

/** Prompt that points the UI chat (or a CLI) at the report a failed run left. */
export function aiFixPrompt(reportPath = FAILURE_REPORT_REL): string {
  return `Read ${reportPath} - it describes a pipeline step that just failed. Fix the errors it reports, then follow its Verify section (Farol pipelines / FAROL_PIPELINES catalog ids — do not invent a literal id).`
}

/**
 * Command to type into a real terminal so the agent picks up a failure and
 * fixes it. Unlike `aiCommand` these are the *interactive* forms — the point
 * is to leave a session the user can keep talking to.
 *
 * The prompt only ever names a fixed path, so there is nothing to quote-escape;
 * everything about the failure lives in the report file itself.
 */
export function aiFixCommand(
  provider: AiProvider,
  reportPath = FAILURE_REPORT_REL,
  via?: OpenRouterAgent
): string {
  const ask = aiFixPrompt(reportPath)
  switch (cliFor(provider, via)) {
    case 'codex':
      return `codex "${ask}"`
    case 'cursor':
      // `cursor-agent` rather than the `agent` alias, which is ambiguous on PATH.
      return `cursor-agent "${ask}"`
    case 'opencode':
      // opencode's TUI takes no opening prompt, so this one runs headless.
      return `opencode run "${ask}"`
    case 'omp':
      return `omp "${ask}"`
    case 'pi':
      return `pi "${ask}"`
    case 'claude':
      return `claude "${ask}"`
  }
}

/** Interactive CLI entry point for a dedicated Terminal agent session. */
export function interactiveAiCommand(provider: AiProvider, via?: OpenRouterAgent): string {
  switch (cliFor(provider, via)) {
    case 'codex':
      return 'codex'
    case 'cursor':
      return 'cursor-agent'
    case 'opencode':
      return 'opencode'
    case 'omp':
      return 'omp'
    case 'pi':
      return 'pi'
    case 'claude':
      return 'claude'
  }
}
