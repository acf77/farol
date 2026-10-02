import { createServer } from 'http'
import { SANDBOX_TIMEOUT_MS, SNAPSHOT_LIMIT_BYTES, snapshotSummary } from '../shared/remote'
import { openSandbox, type SandboxCredentials } from '../electron/sandbox'
import type { AuthConfig, LoginConfig } from './auth'
import { GitHub } from './github'
import { createHandler } from './http'
import { createKey, listKeys, revokeKey } from './keys'
import { openRailwaySandbox } from './railway'
import { createReceiptHandler } from './receipt'
import { RunRegistry, type OpenWorkspace } from './runs'
import { disableUser, enableUser, listUsers, revokeSessions } from './users'
import { WorkspaceRegistry } from './workspaces'

/**
 * Farol run service: starts pipeline runs in Vercel or Railway Sandboxes for web and
 * mobile clients. `farol-service` serves; `farol-service keys create|list|revoke` manages
 * API keys and `farol-service users list|disable|enable|signout` manages GitHub users.
 */

const env = process.env
const keysFile = env.FAROL_KEYS_FILE ?? './farol-keys.json'
const usersFile = env.FAROL_USERS_FILE ?? './farol-users.json'

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

const usersCommands: Record<string, (login: string) => number> = {
  list() {
    for (const user of listUsers(usersFile)) {
      console.log(`${user.githubId}  ${user.login}  last sign-in ${user.lastLoginAt}${user.disabledAt ? '  disabled' : ''}`)
    }
    return 0
  },
  disable: (login) => report(disableUser(usersFile, login), `Disabled ${login}.`, login),
  enable: (login) => report(enableUser(usersFile, login), `Enabled ${login}.`, login),
  signout: (login) => report(revokeSessions(usersFile, login), `Signed ${login} out everywhere.`, login)
}

function report(done: boolean, message: string, login: string): number {
  console.log(done ? message : `No user ${login}.`)
  return done ? 0 : 1
}

function usersCommand([action, arg = '']: string[]): number {
  const command = Object.hasOwn(usersCommands, action) ? usersCommands[action] : undefined
  if (command && (arg || action === 'list')) return command(arg)
  console.error('Usage: users list | users disable <login> | users enable <login> | users signout <login>')
  return 2
}

const list = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)

/** GitHub sign-in, when GITHUB_CLIENT_ID is set. Refuses to start half-configured. */
function loginConfig(): LoginConfig | undefined {
  const clientId = env.GITHUB_CLIENT_ID
  if (!clientId) return undefined
  const sessionSecret = env.FAROL_SESSION_SECRET ?? ''
  if (sessionSecret.length < 32) throw new Error('Set FAROL_SESSION_SECRET to at least 32 random characters.')
  const access = {
    users: list(env.FAROL_ALLOWED_GITHUB_USERS),
    orgs: list(env.FAROL_ALLOWED_GITHUB_ORGS),
    anyone: env.FAROL_ALLOW_ANY_GITHUB_USER === '1'
  }
  if (!access.anyone && !access.users.length && !access.orgs.length) {
    console.warn('GitHub sign-in is on but nobody is allowed: set FAROL_ALLOWED_GITHUB_USERS or FAROL_ALLOWED_GITHUB_ORGS.')
  }
  const github = new GitHub({
    clientId,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    redirectUris: list(env.FAROL_AUTH_REDIRECTS)
  })
  return { github, usersFile, sessionSecret, access }
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
  if (env.FAROL_ALLOW_ANONYMOUS) {
    throw new Error('FAROL_ALLOW_ANONYMOUS was removed: sign in with GitHub (GITHUB_CLIENT_ID) or use API keys.')
  }
  const auth: AuthConfig = { keysFile, login: loginConfig() }
  const open = openWorkspace()
  const maxActive = Number(env.FAROL_MAX_RUNS) || 4
  // Runs and workspaces draw on one pool of sandboxes.
  const inUse = (): number => registry.active + workspaces.active
  const registry = new RunRegistry(open, { maxActive, retentionMs: 60 * 60_000, inUse })
  const workspaces = new WorkspaceRegistry(open, { maxActive, idleMs: SANDBOX_TIMEOUT_MS, inUse })
  const server = createServer(
    createHandler({
      auth,
      registry,
      workspaces,
      snapshotLimit: SNAPSHOT_LIMIT_BYTES,
      allowedOrigins: (env.FAROL_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)
    })
  )
  const port = Number(env.PORT) || 8787
  server.listen(port, env.HOST ?? '0.0.0.0', () =>
    console.log(`farol-service listening on :${port}${auth.login ? ' (GitHub sign-in on)' : ''}`)
  )

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
else if (command === 'users') process.exit(usersCommand(rest))
else if (env.RAILWAY_API_TOKEN || env.VERCEL_TOKEN) serve()
else serveReceipts()
