/** Which coding CLI an AI pipeline step invokes. */

export const AI_PROVIDERS = ['claude', 'codex', 'cursor', 'opencode'] as const
export type AiProvider = (typeof AI_PROVIDERS)[number]

export const AI_LABELS: Record<AiProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode'
}

export function isAiProvider(value: unknown): value is AiProvider {
  return value === 'claude' || value === 'codex' || value === 'cursor' || value === 'opencode'
}

/** Older pipelines omit `ai`; they keep running Claude. */
export function normalizeAi(value: unknown): AiProvider {
  return isAiProvider(value) ? value : 'claude'
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
}

/**
 * Non-interactive argv for each CLI. Cursor runs in ask mode with plain
 * text so a review step returns a string instead of Agent "ACT" chrome.
 * `--force` still auto-approves read tools so it cannot stall on a prompt.
 */
export function aiCommand(provider: AiProvider, prompt: string): AiCommand {
  switch (provider) {
    case 'codex':
      return {
        bins: ['codex'],
        args: ['exec', prompt],
        hint: "Install the Codex CLI (npm i -g @openai/codex) to run Codex steps."
      }
    case 'cursor':
      return {
        bins: ['agent', 'cursor-agent'],
        args: ['-p', '--force', '--mode=ask', '--output-format', 'text', prompt],
        hint: 'Install the Cursor CLI (https://cursor.com/docs/cli) to run Cursor steps.'
      }
    case 'opencode':
      return {
        bins: ['opencode'],
        args: ['run', '--auto', prompt],
        hint: 'Install the OpenCode CLI (https://opencode.ai) to run OpenCode steps.'
      }
    case 'claude':
      return {
        bins: ['claude'],
        args: ['-p', prompt],
        hint: 'Install the Claude Code CLI (npm i -g @anthropic-ai/claude-code) to run Claude steps.'
      }
  }
}

/**
 * Headless coding commands used by Farol's managed Chat harness.
 * stdin is ignored (see agent-controller.ts), so a mode that can still stop
 * to ask for approval — e.g. Claude's `acceptEdits`, which only auto-accepts
 * edits and leaves Bash pending — would hang forever. Every provider here
 * must therefore auto-approve *all* tool calls, including shell commands.
 *
 * Claude and Cursor print nothing at all under `--output-format text` until
 * the whole run is over, which leaves Chat blank while the agent works, so
 * both run in `stream-json` and are decoded by `shared/agent-stream.ts`.
 * Codex and OpenCode already narrate their progress on stdout as they go.
 */
export function managedAiCommand(provider: AiProvider, prompt: string): AiCommand {
  switch (provider) {
    case 'codex':
      return {
        bins: ['codex'],
        args: ['exec', '--full-auto', prompt],
        hint: "Install the Codex CLI (npm i -g @openai/codex) to use managed Chat."
      }
    case 'cursor':
      return {
        bins: ['agent', 'cursor-agent'],
        // Agent mode is the CLI default. Current Cursor releases only accept
        // explicit `plan` and `ask` values for --mode.
        args: ['-p', '--force', '--output-format', 'stream-json', prompt],
        hint: 'Install the Cursor CLI (https://cursor.com/docs/cli) to use managed Chat.',
        stream: 'ndjson'
      }
    case 'opencode':
      return {
        bins: ['opencode'],
        args: ['run', '--dangerously-skip-permissions', prompt],
        hint: 'Install OpenCode (https://opencode.ai) to use managed Chat.'
      }
    case 'claude':
      return {
        bins: ['claude'],
        // `--verbose` is what makes stream-json emit each turn as it happens;
        // without it the CLI still waits and prints one final event.
        args: [
          '-p',
          '--output-format',
          'stream-json',
          '--verbose',
          '--permission-mode',
          'bypassPermissions',
          prompt
        ],
        hint: 'Install Claude Code (npm i -g @anthropic-ai/claude-code) to use managed Chat.',
        stream: 'ndjson'
      }
  }
}

import { FAILURE_REPORT_REL } from './failure'

/** Prompt that points the UI chat (or a CLI) at the report a failed run left. */
export function aiFixPrompt(reportPath = FAILURE_REPORT_REL): string {
  return `Read ${reportPath} - it describes a pipeline step that just failed. Fix the errors it reports.`
}

/**
 * Command to type into a real terminal so the agent picks up a failure and
 * fixes it. Unlike `aiCommand` these are the *interactive* forms — the point
 * is to leave a session the user can keep talking to.
 *
 * The prompt only ever names a fixed path, so there is nothing to quote-escape;
 * everything about the failure lives in the report file itself.
 */
export function aiFixCommand(provider: AiProvider, reportPath = FAILURE_REPORT_REL): string {
  const ask = aiFixPrompt(reportPath)
  switch (provider) {
    case 'codex':
      return `codex "${ask}"`
    case 'cursor':
      // `cursor-agent` rather than the `agent` alias, which is ambiguous on PATH.
      return `cursor-agent "${ask}"`
    case 'opencode':
      // opencode's TUI takes no opening prompt, so this one runs headless.
      return `opencode run "${ask}"`
    case 'claude':
      return `claude "${ask}"`
  }
}

/** Interactive CLI entry point for a dedicated Terminal agent session. */
export function interactiveAiCommand(provider: AiProvider): string {
  switch (provider) {
    case 'codex':
      return 'codex'
    case 'cursor':
      return 'cursor-agent'
    case 'opencode':
      return 'opencode'
    case 'claude':
      return 'claude'
  }
}
