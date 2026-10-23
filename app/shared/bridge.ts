/**
 * The link between the MCP server process and the running app.
 *
 * An agent's pipeline run has to appear in the UI — run tab, streaming log,
 * sidebar status — so the run happens in the app's own runner and the MCP
 * server just asks for it over a local socket. The path is derived from the
 * project so it is stable across app restarts, which keeps the `.mcp.json`
 * the app writes into the project from churning on every launch.
 *
 * A Farol-managed git hook is the same idea in reverse: git, not an agent,
 * asks the running app to run whatever pipelines are configured for that
 * hook event.
 */

import type { GitHookEvent } from './types'

/** Env var carrying the socket path from `.mcp.json` to the MCP server. */
export const BRIDGE_ENV = 'FAROL_SOCKET'

/** Cheap, stable, filename-safe digest — this names a socket, not a secret. */
export function projectKey(projectPath: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < projectPath.length; i++) {
    const c = projectPath.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c + 1, 0x85ebca6b) >>> 0
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 16)
}

export function socketPathFor(projectPath: string, tmpDir: string, sep = '/'): string {
  return `${tmpDir.replace(/[/\\]+$/, '')}${sep}farol-${projectKey(projectPath)}.sock`
}

/**
 * What a bridge client wants. `cwd` is the caller's directory, not the app's —
 * the MCP server passes an agent's cwd, and a Farol-managed git hook passes
 * the repo root git invoked it in.
 */
export type BridgeAsk =
  | { op: 'list'; cwd: string }
  | { op: 'run'; cwd: string; pipeline: string }
  | { op: 'hook'; cwd: string; event: GitHookEvent }
  | DelegateAsk
  | ApproveAsk

/**
 * Managed Chat's `delegate` tool, sent to the app-wide managed socket rather
 * than a project's. `token` is the secret the app put in the managed server's
 * env, so another local process cannot drive a Chat by guessing its task id.
 */
export interface DelegateAsk {
  op: 'delegate'
  token: string
  taskId: string
  provider: string
  model?: string
  task: string
  context?: string
}

/**
 * Claude's permission prompt for one tool call, sent from the managed
 * server's `approve` tool. `delegateId` is set when a subagent asks.
 */
export interface ApproveAsk {
  op: 'approve'
  token: string
  taskId: string
  delegateId?: string
  toolName: string
  input: unknown
}

export type BridgeRequest = BridgeAsk & { id: number }

export type BridgeReply =
  | { id: number; ok: true; op: 'list'; pipelines: { id: string; name: string; steps: string[] }[] }
  | { id: number; ok: true; op: 'run'; text: string; failed: boolean }
  | { id: number; ok: true; op: 'hook'; text: string; failed: boolean }
  | { id: number; ok: true; op: 'delegate'; text: string; failed: boolean }
  | { id: number; ok: true; op: 'approve'; allow: boolean; message?: string }
  | { id: number; ok: false; message: string }

/** Newline-delimited JSON: split a stream buffer into whole messages. */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  return { lines: parts.slice(0, -1).filter((l) => l.trim()), rest: parts[parts.length - 1] }
}
