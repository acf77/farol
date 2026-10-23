/**
 * Codex's half of "Ask first". `codex exec` has no permission-prompt tool, but
 * it runs `PreToolUse` hooks before every tool call: a hook that prints a
 * `deny` blocks the call, and one that prints nothing lets it run. Farol
 * passes such a hook for one run with `-c`, and the hook asks the developer
 * over the managed bridge, as Claude's `approve` tool does.
 *
 * Verified against Codex 0.164: hooks passed with `-c` are ignored unless the
 * run also gets `--dangerously-bypass-hook-trust`, and a hook that times out
 * lets the call through. The controller therefore checks that every write or
 * shell call in such a run was approved first (see `AgentController`).
 */

import { isDelegateToolName, MANAGED_MCP_SERVER_KEY, MANAGED_TOOL_TIMEOUT_SEC, type McpServerEntry } from './mcp-config'

/** The part of Codex's hook input Farol reads. */
export interface CodexHookInput {
  tool_name?: unknown
  tool_input?: unknown
}

/** Files an `apply_patch` call touches, from its `*** Add/Update/Delete File:` lines. */
export function patchedFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim())
}

/**
 * What to ask the developer about, or undefined for a call that never needs
 * asking: Farol's own managed tools.
 */
export function codexApprovalAsk(hook: CodexHookInput): { toolName: string; input: unknown } | undefined {
  const toolName = typeof hook.tool_name === 'string' && hook.tool_name ? hook.tool_name : 'tool'
  if (isDelegateToolName(toolName) || toolName.includes(MANAGED_MCP_SERVER_KEY)) return undefined
  const input = hook.tool_input
  if (toolName === 'apply_patch' && input && typeof input === 'object') {
    const patch = (input as Record<string, unknown>).command
    const files = typeof patch === 'string' ? patchedFiles(patch) : []
    // The patch itself is too long for the card; the files it touches say what it does.
    if (files.length) return { toolName, input: { file_path: files.join(', ') } }
  }
  return { toolName, input: input ?? {} }
}

/** What the hook prints: nothing lets the call run; a deny needs a reason or Codex rejects it. */
export function codexHookReply(answer: { allow: boolean; message?: string }): string {
  if (answer.allow) return ''
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: answer.message?.trim() || 'The developer declined this.'
    }
  })
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The hook's command line: `entry` run with its env, quoted for the shell Codex runs hooks with. */
export function codexHookCommand(entry: McpServerEntry): string {
  const env = Object.entries(entry.env ?? {}).map(([name, value]) => `${name}=${shellQuote(value)}`)
  return ['env', ...env, shellQuote(entry.command), ...entry.args.map(shellQuote)].join(' ')
}

/** `codex exec` arguments that install the hook for one run. */
export function codexHookArgs(command: string): string[] {
  const hook = `{ type = "command", command = ${JSON.stringify(command)}, timeout = ${MANAGED_TOOL_TIMEOUT_SEC} }`
  return ['-c', `hooks.PreToolUse=[{ matcher = "*", hooks = [${hook}] }]`, '--dangerously-bypass-hook-trust']
}

/** Codex's warning about the trust flag Farol itself passed; not worth showing. */
export function isCodexHookTrustWarning(message: string): boolean {
  return message.includes('--dangerously-bypass-hook-trust')
}
