/** Where agents look for BuildFlow's MCP server. Same JSON shape in each. */
export const MCP_CONFIG_REL_PATHS = ['.mcp.json', '.cursor/mcp.json'] as const

export const MCP_SERVER_KEY = 'buildflow'

export interface McpServerEntry {
  command: string
  args: string[]
  env?: Record<string, string>
}

/**
 * Merge BuildFlow's entry into an existing MCP JSON config, touching nothing
 * else — the file may already list other servers (project or `~/.cursor`).
 * Same shape for Claude (`.mcp.json`) and Cursor (`.cursor/mcp.json`).
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
      ? (root.mcpServers as Record<string, unknown>)
      : {}
  const current = servers[MCP_SERVER_KEY]
  if (current && JSON.stringify(current) === JSON.stringify(entry)) return null
  const next = {
    ...root,
    mcpServers: { ...servers, [MCP_SERVER_KEY]: entry }
  }
  return JSON.stringify(next, null, 2) + '\n'
}
