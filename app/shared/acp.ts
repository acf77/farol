/**
 * Agent Client Protocol (ACP): JSON-RPC 2.0 over a CLI's stdio, spoken by
 * `opencode acp` and `omp acp`. One session carries what the plain JSON modes
 * cannot: Farol's managed MCP server (`session/new.mcpServers`) and permission
 * requests the developer can answer (`session/request_permission`).
 *
 * This file only maps ACP messages to Farol's own shapes; the process and the
 * JSON-RPC traffic live in `electron/acp-run.ts`. Shapes below were checked
 * against OpenCode 1.19.4 and OMP 18.12.6.
 */

import type { AgentMode } from './ai'
import type { McpServerEntry } from './mcp-config'

export const ACP_PROTOCOL_VERSION = 1

/** A stdio MCP server as `session/new` takes it: env as name/value pairs. */
export interface AcpMcpServer {
  name: string
  command: string
  args: string[]
  env: { name: string; value: string }[]
}

export function acpMcpServer(name: string, entry: McpServerEntry): AcpMcpServer {
  return {
    name,
    command: entry.command,
    args: entry.args,
    env: Object.entries(entry.env ?? {}).map(([key, value]) => ({ name: key, value }))
  }
}

/** One select option from `session/new`'s `configOptions` (model, mode, …). */
export interface AcpConfigOption {
  id: string
  currentValue?: unknown
  options?: { value?: unknown }[]
}

/** Whether a select option offers `value`. */
export function acpOffers(options: AcpConfigOption[] | undefined, id: string, value: string): boolean {
  const option = options?.find((o) => o.id === id)
  return !!option?.options?.some((o) => o.value === value)
}

/**
 * The session mode for Farol's Plan or Build. Plan is read-only only where the
 * CLI enforces it (with OpenCode, together with its run config); a CLI whose
 * modes do not include `plan` must not be used for Plan at all.
 */
export function acpModeValue(mode: AgentMode, options: AcpConfigOption[] | undefined): string | undefined {
  if (mode === 'plan') return acpOffers(options, 'mode', 'plan') ? 'plan' : undefined
  for (const build of ['build', 'default']) if (acpOffers(options, 'mode', build)) return build
  return undefined
}

/** ACP's tool kinds, named the way Farol's tool cards and write/shell checks expect. */
const KIND_NAMES: Record<string, string> = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
  search: 'grep',
  execute: 'bash',
  fetch: 'webfetch',
  think: 'think'
}

export interface AcpToolCall {
  toolCallId?: unknown
  title?: unknown
  kind?: unknown
  status?: unknown
  rawInput?: unknown
  locations?: unknown
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)

/**
 * The tool's name for Farol: its ACP kind, or, for `other` (MCP tools and
 * anything without a kind), the title the CLI gave it — `farol-chat_delegate`.
 */
export function acpToolName(call: AcpToolCall, known?: string): string {
  const kind = str(call.kind)
  if (kind && kind !== 'other' && KIND_NAMES[kind]) return KIND_NAMES[kind]
  return known ?? str(call.title) ?? 'tool'
}

/**
 * What the call touches: a command, a path, or failing those, its title. A
 * shell call's location is only its working directory, and a title that just
 * repeats the tool's name says nothing, so neither stands in for a detail.
 */
export function acpToolDetail(call: AcpToolCall): string | undefined {
  const input = call.rawInput && typeof call.rawInput === 'object' ? (call.rawInput as Record<string, unknown>) : {}
  const direct = str(input.command) ?? str(input.filePath) ?? str(input.file_path) ?? str(input.path) ?? str(input.url) ?? str(input.pattern)
  if (direct) return direct
  const first = Array.isArray(call.locations) ? (call.locations[0] as Record<string, unknown> | undefined) : undefined
  const location = call.kind === 'execute' ? undefined : str(first?.path)
  const title = str(call.title)
  return location ?? (title && title !== acpToolName(call) ? title : undefined)
}

export function acpToolState(status: unknown): 'running' | 'done' | 'error' | undefined {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'error'
  if (status === 'pending' || status === 'in_progress') return 'running'
  return undefined
}

/** The question for `requestApproval`: the tool, and the input the developer judges it by. */
export function acpApprovalAsk(call: AcpToolCall): { toolName: string; input: unknown } {
  const input = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}
  const detail = acpToolDetail(call)
  const named = Object.keys(input).length ? input : detail ? { command: detail } : {}
  return { toolName: acpToolName(call), input: named }
}

export interface AcpPermissionOption {
  optionId: string
  kind: string
}

/**
 * The option to answer a permission request with: allow once, or reject once.
 * "Allow for this chat" is kept by Farol, so the CLI is never told to always
 * allow something the developer could take back. Undefined when the CLI
 * offered no such option, which the caller answers as cancelled.
 */
export function acpPermissionChoice(options: AcpPermissionOption[], allow: boolean): string | undefined {
  const wanted = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
  for (const kind of wanted) {
    const match = options.find((o) => o.kind === kind)
    if (match) return match.optionId
  }
  return undefined
}

/** A `session/prompt` result as an exit code: anything but a finished turn is a failure. */
export function acpExitCode(stopReason: unknown): number {
  return stopReason === 'end_turn' || stopReason === 'max_tokens' || stopReason === 'max_turn_requests' ? 0 : 1
}
