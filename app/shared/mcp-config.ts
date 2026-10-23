/** Where agents look for Farol's MCP server. Same JSON shape in each. */
export const MCP_CONFIG_REL_PATHS = ['.mcp.json', '.cursor/mcp.json'] as const

export const MCP_SERVER_KEY = 'farol'
/** Pre-rename MCP key — drop it when writing `farol` so agents stop spawning BuildFlow.app. */
const LEGACY_MCP_SERVER_KEY = 'buildflow'

export interface McpServerEntry {
  command: string
  args: string[]
  env?: Record<string, string>
}

/**
 * Merge Farol's entry into an existing MCP JSON config, touching nothing
 * else — the file may already list other servers (project or `~/.cursor`).
 * Same shape for Claude (`.mcp.json`) and Cursor (`.cursor/mcp.json`).
 * Also removes a leftover `buildflow` key from the rename.
 * Returns null when the file already says exactly this, so it is not rewritten
 * (and so opening a project does not dirty the working tree).
 */
export function mergeMcpConfig(existing: string, entry: McpServerEntry): string | null {
  let root: Record<string, unknown> = {}
  if (existing.trim()) {
    try {
      const parsed = JSON.parse(existing)
      // Anything that is not a JSON object is not ours to rewrite.
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      root = parsed as Record<string, unknown>
    } catch {
      return null
    }
  }
  const servers =
    root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers)
      ? { ...(root.mcpServers as Record<string, unknown>) }
      : {}
  const hadLegacy = LEGACY_MCP_SERVER_KEY in servers
  delete servers[LEGACY_MCP_SERVER_KEY]
  const current = servers[MCP_SERVER_KEY]
  if (!hadLegacy && current && JSON.stringify(current) === JSON.stringify(entry)) return null
  const next = {
    ...root,
    mcpServers: { ...servers, [MCP_SERVER_KEY]: entry }
  }
  return JSON.stringify(next, null, 2) + '\n'
}

/**
 * Farol's own server inside managed Chat. A key of its own, so the project's
 * `farol` entry (pipeline tools for agents outside Farol) cannot shadow it.
 */
export const MANAGED_MCP_SERVER_KEY = 'farol-chat'
/** Set on the managed server so `mcp.ts` serves Chat's tools, not the pipeline tools. */
export const MANAGED_ENV = 'FAROL_MANAGED'
/** The Chat task a managed server belongs to. */
export const TASK_ENV = 'FAROL_TASK_ID'
/** The secret the managed bridge expects with every request. */
export const TOKEN_ENV = 'FAROL_CHAT_TOKEN'
/** Set when the server belongs to a subagent: it may ask for approval but not delegate. */
export const DELEGATE_ENV = 'FAROL_DELEGATE_ID'
/** The managed tools this server offers, comma-separated. */
export const TOOLS_ENV = 'FAROL_TOOLS'

/**
 * The project `farol` server's tools, as managed Claude names them. Chat must
 * not call them: the agent selects pipelines with FAROL_PIPELINES and the
 * harness runs them, whereas an MCP run (origin `agent`) never hands its
 * failures back for repair.
 */
export const PIPELINE_MCP_TOOLS = [`mcp__${MCP_SERVER_KEY}__list_pipelines`, `mcp__${MCP_SERVER_KEY}__run_pipeline`]

/**
 * Tools the managed server offers. Until there is one, managed Chat does not
 * start the server at all: a server with no tools fails the client's tool
 * listing and shows up as a broken server.
 */
export const MANAGED_MCP_TOOLS = ['delegate', 'approve'] as const
export type ManagedTool = (typeof MANAGED_MCP_TOOLS)[number]

/**
 * The tools one run's server offers: `delegate` for the chat's own agent
 * (never a subagent's), and `approve` only where Claude asks through it — no
 * other CLI needs it, and a model that sees it might call it.
 */
export function managedToolsFor(run: { subagent: boolean; claudeAsks: boolean }): ManagedTool[] {
  return [...(run.subagent ? [] : (['delegate'] as const)), ...(run.claudeAsks ? (['approve'] as const) : [])]
}

/** The tools `env` names; absent means all of them, as before `FAROL_TOOLS` existed. */
export function servedTools(env: Record<string, string | undefined>): ManagedTool[] {
  const listed = env[TOOLS_ENV]
  if (listed === undefined) return [...MANAGED_MCP_TOOLS]
  return MANAGED_MCP_TOOLS.filter((tool) => listed.split(',').includes(tool))
}

/**
 * The managed tool Claude's `--permission-prompt-tool` points at: it asks the
 * developer in Chat whether a tool call may run.
 */
export const APPROVE_TOOL = `mcp__${MANAGED_MCP_SERVER_KEY}__approve`
/** Farol's own delegate tool, which never needs the developer's approval. */
export const DELEGATE_TOOL = `mcp__${MANAGED_MCP_SERVER_KEY}__delegate`

/** How each provider names the managed `delegate` call: Claude, Codex, and ACP CLIs (OpenCode, OMP). */
export function isDelegateToolName(name: string): boolean {
  return (
    name === DELEGATE_TOOL ||
    name === `${MANAGED_MCP_SERVER_KEY}.delegate` ||
    name === `${MANAGED_MCP_SERVER_KEY}_delegate`
  )
}

/**
 * How long the parent CLI may wait on one managed tool call. Subagents have no
 * time cap of their own, so this is only there because the clients insist on
 * one: a day, in each client's unit.
 */
export const MANAGED_TOOL_TIMEOUT_SEC = 24 * 60 * 60

/** Whether this MCP server process should offer `list_pipelines` / `run_pipeline`. */
export function servesPipelineTools(env: Record<string, string | undefined>): boolean {
  return env[MANAGED_ENV] !== '1'
}

/** `base` (the app's `mcp.js` entry, pointed at the managed socket) started for one managed Chat task. */
export function managedMcpEntry(
  base: McpServerEntry,
  taskId: string,
  delegateId?: string,
  tools?: readonly ManagedTool[]
): McpServerEntry {
  return {
    ...base,
    env: {
      ...base.env,
      [MANAGED_ENV]: '1',
      [TASK_ENV]: taskId,
      ...(delegateId ? { [DELEGATE_ENV]: delegateId } : {}),
      ...(tools ? { [TOOLS_ENV]: tools.join(',') } : {})
    }
  }
}

/** Inline value for Claude's `--mcp-config`, which takes a JSON string as well as a path. */
export function claudeMcpConfig(entry: McpServerEntry): string {
  return JSON.stringify({ mcpServers: { [MANAGED_MCP_SERVER_KEY]: entry } })
}

/**
 * `-c` overrides that add the managed server to one Codex run without
 * touching the user's `config.toml`. Codex parses each value as TOML, and a
 * JSON string or string array is valid TOML.
 */
export function codexMcpOverrides(entry: McpServerEntry): string[] {
  const key = `mcp_servers.${MANAGED_MCP_SERVER_KEY}`
  const env = Object.entries(entry.env ?? {})
    .map(([name, value]) => `${JSON.stringify(name)} = ${JSON.stringify(value)}`)
    .join(', ')
  return [
    '-c',
    `${key}.command=${JSON.stringify(entry.command)}`,
    '-c',
    `${key}.args=${JSON.stringify(entry.args)}`,
    ...(env ? ['-c', `${key}.env={ ${env} }`] : []),
    '-c',
    `${key}.tool_timeout_sec=${MANAGED_TOOL_TIMEOUT_SEC}`
  ]
}
