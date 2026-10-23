/** Which coding CLI an AI pipeline step invokes. */

import { codexHookArgs } from './codex-hook'
import { FAILURE_REPORT_REL } from './failure'
import { opencodeRunConfig } from './opencode-config'
import { openCodeModel } from './openrouter'
import {
  APPROVE_TOOL,
  claudeMcpConfig,
  codexMcpOverrides,
  DELEGATE_TOOL,
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

/** CLIs Farol runs over ACP in managed Chat (see `shared/acp.ts`). */
export const ACP_CLIS: readonly AiCli[] = ['opencode']

/**
 * Whether the CLI can stop a headless run to ask the developer about a tool
 * call: Claude through `--permission-prompt-tool`, Codex through a
 * `PreToolUse` hook, ACP CLIs through `session/request_permission`. Every
 * other CLI runs with all tools approved, so auto-approve is always on for it.
 */
export function canAskApproval(provider: AiProvider, via: OpenRouterAgent = 'opencode'): boolean {
  return provider === 'claude' || provider === 'codex' || ACP_CLIS.includes(cliFor(provider, via))
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

/** Older OpenCode builds reject `--format json` with an unknown-option error. */
export function isUnknownJsonFormatError(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('format') && /unknown (option|flag|argument)/.test(lower)
}

/** `--tools a,b` argv fragment, or empty when the CLI should keep its defaults. */
function toolsArgv(tools: string | undefined): string[] {
  return tools ? ['--tools', tools] : []
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

function managedCodexCommand(
  prompt: string,
  passed: string | undefined,
  plan: boolean,
  webSearch?: boolean,
  resume?: string,
  mcp?: McpServerEntry,
  hook?: string
): AiCommand {
  const sandbox = plan ? 'read-only' : 'workspace-write'
  // Ask first: a PreToolUse hook gates every call; Plan's read-only sandbox needs none.
  const gate = hook && !plan ? codexHookArgs(hook) : []
  if (resume) {
    // `exec resume` takes no `--sandbox`; the config key sets the same mode.
    return {
      bins: ['codex'],
      args: withModel(
        [
          'exec',
          'resume',
          '--json',
          '-c',
          'approval_policy=never',
          '-c',
          `sandbox_mode="${sandbox}"`,
          ...(webSearch ? ['-c', 'web_search=live'] : []),
          ...(mcp ? codexMcpOverrides(mcp) : []),
          ...gate,
          resume,
          prompt
        ],
        passed
      ),
      hint: "Install the Codex CLI (npm i -g @openai/codex) to use managed Chat.",
      stream: 'ndjson'
    }
  }
  return {
    bins: ['codex'],
    // Codex removed `--full-auto` (closer to workspace-write + on-request).
    // Use approval_policy=never + sandbox so headless Chat never prompts;
    // do not use --dangerously-bypass-approvals-and-sandbox (no sandbox at all).
    // Keep workspace-write network_access off (default): never-approve + network
    // would let model shell commands reach the internet without confirmation.
    // Native Codex web search is `-c web_search=live`, not sandbox network_access.
    args: withModel(
      [
        'exec',
        '--json',
        '-c',
        'approval_policy=never',
        '--sandbox',
        sandbox,
        ...(webSearch ? ['-c', 'web_search=live'] : []),
        ...(mcp ? codexMcpOverrides(mcp) : []),
        ...gate,
        prompt
      ],
      passed
    ),
    hint: "Install the Codex CLI (npm i -g @openai/codex) to use managed Chat.",
    stream: 'ndjson'
  }
}

function managedCursorCommand(prompt: string, passed: string | undefined, plan: boolean, resume?: string): AiCommand {
  return {
    bins: ['agent', 'cursor-agent'],
    // Agent mode is the CLI default; `plan` is Cursor's own read-only mode.
    args: withModel(
      [
        '-p',
        '--force',
        ...(plan ? ['--mode=plan'] : []),
        ...resumeArgv('--resume', resume),
        '--output-format',
        'stream-json',
        prompt
      ],
      passed
    ),
    hint: 'Install the Cursor CLI (https://cursor.com/docs/cli) to use managed Chat.',
    stream: 'ndjson'
  }
}

function managedOpencodeCommand(
  prompt: string,
  passed: string | undefined,
  plan: boolean,
  jsonFormat: boolean,
  resume?: string
): AiCommand {
  // OpenCode's `plan` agent lacks the write tools, which
  // `--dangerously-skip-permissions` does not grant back; but it runs `bash`
  // freely, so Plan also denies shell through the run's config.
  const planArgv = [...(plan ? ['--agent', 'plan'] : []), ...resumeArgv('--session', resume)]
  const config = opencodeRunConfig(plan ? 'plan' : 'build', false)
  return {
    bins: ['opencode'],
    args: withModel(
      jsonFormat
        ? ['run', '--format', 'json', '--dangerously-skip-permissions', ...planArgv, prompt]
        : ['run', '--dangerously-skip-permissions', ...planArgv, prompt],
      passed
    ),
    hint: 'Install OpenCode (https://opencode.ai) to use managed Chat. Farol needs a build that accepts `opencode run --format json`.',
    ...(jsonFormat ? { stream: 'ndjson' as const } : {}),
    ...(config ? { opencodeConfig: config } : {})
  }
}

function managedOmpCommand(prompt: string, passed: string | undefined, plan: boolean, tools: string | undefined): AiCommand {
  return {
    bins: ['omp'],
    // `--mode json` is already non-interactive, so `-p` is redundant; it also
    // routes omp's own banners to stderr, leaving stdout pure NDJSON.
    // Plan mode defaults to inspection-only when Jev did not supply a list;
    // Build with an explicit allowlist uses that; otherwise omp keeps all tools.
    args: withModel(
      ['--mode', 'json', '--auto-approve', ...toolsArgv(tools ?? (plan ? OMP_READONLY_TOOLS : undefined)), prompt],
      passed
    ),
    hint: 'Install oh-my-pi (npm i -g @oh-my-pi/pi-coding-agent) to use managed Chat.',
    stream: 'ndjson'
  }
}

function managedPiCommand(prompt: string, passed: string | undefined, plan: boolean, tools: string | undefined): AiCommand {
  return {
    bins: ['pi'],
    // `--mode json` is non-interactive on its own. Plan defaults to the
    // inspection-only allowlist, exactly like OMP.
    args: withModel(
      ['--mode', 'json', ...toolsArgv(tools ?? (plan ? PI_READONLY_TOOLS : undefined)), prompt],
      passed
    ),
    hint: PI_HINT,
    stream: 'ndjson'
  }
}

function managedClaudeCommand(
  prompt: string,
  passed: string | undefined,
  plan: boolean,
  tools: string | undefined,
  resume?: string,
  mcp?: McpServerEntry,
  askApproval?: boolean
): AiCommand {
  // Asking goes through the managed server, so it needs one; Plan keeps its own read-only mode.
  const ask = !!(askApproval && mcp && !plan)
  return {
    bins: ['claude'],
    // `--verbose` is what makes stream-json emit each turn as it happens;
    // without it the CLI still waits and prints one final event.
    // The user's MCP servers load as usual, but the project `farol` server's
    // pipeline tools are disallowed: called instead of emitting
    // FAROL_PIPELINES, the managed harness would never run validation, and
    // MCP runs use origin `agent`, which does not hand failures back.
    // `--mcp-config` and `--disallowedTools` take several values, so a
    // single-valued flag must follow them before the prompt.
    args: withModel(
      [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        ...(mcp ? ['--mcp-config', claudeMcpConfig(mcp)] : []),
        '--disallowedTools',
        PIPELINE_MCP_TOOLS.join(','),
        ...(ask ? ['--allowedTools', DELEGATE_TOOL, '--permission-prompt-tool', APPROVE_TOOL] : []),
        '--permission-mode',
        plan ? 'plan' : ask ? 'default' : 'bypassPermissions',
        ...toolsArgv(tools),
        ...resumeArgv('--resume', resume),
        prompt
      ],
      passed
    ),
    hint: 'Install Claude Code (npm i -g @anthropic-ai/claude-code) to use managed Chat.',
    stream: 'ndjson'
  }
}

/**
 * Headless coding commands used by Farol's managed Chat harness.
 * stdin is ignored (see agent-controller.ts), so a mode that can still stop
 * to ask for approval — e.g. Claude's `acceptEdits`, which only auto-accepts
 * edits and leaves Bash pending — would hang forever. Every provider here
 * must therefore auto-approve *all* tool calls, including shell commands,
 * except in Plan mode (`opts.mode === 'plan'`), where the CLI's own
 * read-only plan mode replaces full auto-approval.
 *
 * Claude and Cursor print nothing at all under `--output-format text` until
 * the whole run is over, which leaves Chat blank while the agent works, so
 * both run in `stream-json` and are decoded by `shared/agent-stream.ts`.
 * Codex also emits NDJSON when passed `--json`; decoding it lets managed Chat
 * render command, file, MCP, and web-search activity as tool cards.
 * OpenCode does the same with `--format json`, and OMP and pi with `--mode json`;
 * OpenRouter rides whichever of OpenCode or pi `opts.via` names.
 *
 * `opts.resume` continues the CLI's own saved conversation (see
 * `shared/agent-context.ts`). OMP and pi have no headless resume and ignore it.
 */
export function managedAiCommand(
  provider: AiProvider,
  prompt: string,
  model?: string,
  opts?: {
    jsonFormat?: boolean
    mode?: AgentMode
    tools?: string[]
    webSearch?: boolean
    via?: OpenRouterAgent
    resume?: string
    /** Farol's managed server for this task; Claude and Codex load it for the run. */
    mcp?: McpServerEntry
    /** Ask the developer before tool calls instead of approving them all (Claude, Build, with `mcp`). */
    askApproval?: boolean
    /** Codex's Ask-first hook command (see `shared/codex-hook.ts`); Build only. */
    codexHook?: string
  }
): AiCommand {
  const { via, resume: resumeId, mode, tools: toolList, webSearch, mcp, askApproval, codexHook } = opts ?? {}
  const cli = cliFor(provider, via)
  const resume = resumeId?.trim() || undefined
  const passed = provider === 'openrouter' ? openCodeModel(model) : model
  const jsonFormat = opts?.jsonFormat !== false
  const plan = mode === 'plan'
  const tools = toolList?.length ? toolList.join(',') : undefined
  switch (cli) {
    case 'codex':
      return managedCodexCommand(prompt, passed, plan, webSearch, resume, mcp, codexHook)
    case 'cursor':
      return managedCursorCommand(prompt, passed, plan, resume)
    case 'opencode':
      return managedOpencodeCommand(prompt, passed, plan, jsonFormat, resume)
    case 'omp':
      return managedOmpCommand(prompt, passed, plan, tools)
    case 'pi':
      return managedPiCommand(prompt, passed, plan, tools)
    case 'claude':
      return managedClaudeCommand(prompt, passed, plan, tools, resume, mcp, askApproval)
  }
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
