import { createServer } from 'http'
import { SANDBOX_TIMEOUT_MS, SNAPSHOT_LIMIT_BYTES, snapshotSummary } from '../shared/remote'
import { openSandbox, type SandboxCredentials } from '../electron/sandbox'
import { createHandler } from './http'
import { createKey, listKeys, revokeKey } from './keys'
import { openRailwaySandbox } from './railway'
import { createReceiptHandler } from './receipt'
import { RunRegistry, type OpenWorkspace } from './runs'
import { WorkspaceRegistry } from './workspaces'

/**
 * Farol run service: starts pipeline runs in Vercel or Railway Sandboxes for web and
 * mobile clients. `farol-service` serves; `farol-service keys create|list|revoke` manages API keys.
 */

const env = process.env
const keysFile = env.FAROL_KEYS_FILE ?? './farol-keys.json'

const keysCommands: Record<string, (arg: string) => number> = {
  create(name) {
    const { id, key } = createKey(keysFile, name)
    console.log(`Created key ${id} for "${name}". Store it now; it cannot be shown again:\n${key}`)
    return 0
  },
  list() {
    for (const key of listKeys(keysFile)) {
      console.log(`${key.id}  ${key.name}  ${key.createdAt}${key.revokedAt ? '  revoked' : ''}`)
    }
    return 0
  },
  revoke(id) {
    const revoked = revokeKey(keysFile, id)
    console.log(revoked ? `Revoked ${id}.` : `No active key ${id}.`)
    return revoked ? 0 : 1
  }
}

function keysCommand([action, arg = '']: string[]): number {
  const command = Object.hasOwn(keysCommands, action) ? keysCommands[action] : undefined
  if (command && (arg || action === 'list')) return command(arg)
  console.error('Usage: keys create <name> | keys list | keys revoke <id>')
  return 2
}

function vercelCredentials(): SandboxCredentials {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = env
  if (!token || !teamId || !projectId) {
    throw new Error('Set VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID.')
  }
  return { token, teamId, projectId }
}

/** Railway is preferred when its token is set; the CLI reads RAILWAY_API_TOKEN itself. */
function openWorkspace(): OpenWorkspace {
  if (env.RAILWAY_API_TOKEN) {
    return (archive, signal) => openRailwaySandbox(archive, snapshotSummary(0, archive.length), signal)
  }
  const creds = vercelCredentials()
  return (archive, signal) => openSandbox(creds, archive, snapshotSummary(0, archive.length), signal)
}

function serveReceipts(): void {
  const port = Number(env.PORT) || 8787
  createServer(createReceiptHandler(SNAPSHOT_LIMIT_BYTES)).listen(port, env.HOST ?? '0.0.0.0', () =>
    console.log(`farol-service (receipt mode, no sandbox credentials) listening on :${port}`)
  )
}

function serve(): void {
  const open = openWorkspace()
  const maxActive = Number(env.FAROL_MAX_RUNS) || 4
  // Runs and workspaces draw on one pool of sandboxes.
  const inUse = (): number => registry.active + workspaces.active
  const registry = new RunRegistry(open, { maxActive, retentionMs: 60 * 60_000, inUse })
  const workspaces = new WorkspaceRegistry(open, { maxActive, idleMs: SANDBOX_TIMEOUT_MS, inUse })
  const server = createServer(
    createHandler({
      keysFile,
      registry,
      workspaces,
      snapshotLimit: SNAPSHOT_LIMIT_BYTES,
      anonymous: env.FAROL_ALLOW_ANONYMOUS === '1',
      allowedOrigins: (env.FAROL_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)
    })
  )
  const port = Number(env.PORT) || 8787
  server.listen(port, env.HOST ?? '0.0.0.0', () => console.log(`farol-service listening on :${port}`))

  // Stop every sandbox before exiting so a redeploy never leaves billed VMs behind.
  const shutdown = (): void => {
    server.close()
    registry.cancelAll()
    void workspaces.closeAll()
    setInterval(() => {
      if (!registry.active && !workspaces.active) process.exit(0)
    }, 250)
    setTimeout(() => process.exit(1), 30_000).unref()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'keys') process.exit(keysCommand(rest))
else if (env.RAILWAY_API_TOKEN || env.VERCEL_TOKEN) serve()
else serveReceipts()
