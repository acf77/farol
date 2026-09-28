import { createServer } from 'http'
import { SNAPSHOT_LIMIT_BYTES, snapshotSummary } from '../shared/remote'
import { openSandbox, type SandboxCredentials } from '../electron/sandbox'
import { createHandler } from './http'
import { createKey, listKeys, revokeKey } from './keys'
import { RunRegistry } from './runs'

/**
 * Farol run service: starts pipeline runs in Vercel Sandboxes for web and mobile
 * clients. `farol-service` serves; `farol-service keys create|list|revoke` manages API keys.
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

function credentials(): SandboxCredentials {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = env
  if (!token || !teamId || !projectId) {
    throw new Error('Set VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID.')
  }
  return { token, teamId, projectId }
}

function serve(): void {
  const creds = credentials()
  const registry = new RunRegistry(
    (archive, signal) => openSandbox(creds, archive, snapshotSummary(0, archive.length), signal),
    { maxActive: Number(env.FAROL_MAX_RUNS) || 4, retentionMs: 60 * 60_000 }
  )
  const server = createServer(
    createHandler({
      keysFile,
      registry,
      snapshotLimit: SNAPSHOT_LIMIT_BYTES,
      allowedOrigins: (env.FAROL_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)
    })
  )
  const port = Number(env.PORT) || 8787
  server.listen(port, env.HOST ?? '0.0.0.0', () => console.log(`farol-service listening on :${port}`))

  // Stop every sandbox before exiting so a redeploy never leaves billed VMs behind.
  const shutdown = (): void => {
    server.close()
    registry.cancelAll()
    setInterval(() => {
      if (!registry.active) process.exit(0)
    }, 250)
    setTimeout(() => process.exit(1), 30_000).unref()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'keys') process.exit(keysCommand(rest))
else serve()
