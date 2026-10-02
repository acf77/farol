import { verifyKey } from './keys'
import type { GitHub } from './github'
import { isSessionToken, issueSession, readSession } from './sessions'
import { findUser, recordLogin } from './users'

/**
 * Who a request comes from. A bearer token is either an API key (`frl_…`, for
 * scripts and CI, made with `keys create`) or a session (`fs1.…`) issued after a
 * GitHub sign-in. Runs and workspaces belong to `Identity.id`.
 */

export interface Identity {
  /** `key:<id>` or `user:<github id>`; the owner of everything the caller starts. */
  id: string
  kind: 'key' | 'user'
  /** GitHub user id, for `user` identities. */
  githubId?: number
  /** Key name or GitHub login. */
  name: string
}

/** Who may sign in. Nobody can unless at least one of these is set. */
export interface AccessPolicy {
  /** GitHub logins, compared case-insensitively. */
  users: string[]
  /** GitHub organizations; an active member of any may sign in. */
  orgs: string[]
  /** Any GitHub account may sign in. */
  anyone: boolean
}

export interface LoginConfig {
  github: GitHub
  usersFile: string
  /** HMAC key for session tokens; rotating it signs everyone out. */
  sessionSecret: string
  access: AccessPolicy
}

export interface AuthConfig {
  keysFile: string
  /** GitHub sign-in; without it only API keys are accepted. */
  login?: LoginConfig
}

export class AccessDenied extends Error {}

const listed = (access: AccessPolicy, login: string): boolean =>
  access.anyone || access.users.some((u) => u.toLowerCase() === login.toLowerCase())

/**
 * Whether a user who already signed in is still let in. Organization membership is
 * only checked at sign-in (it needs the GitHub token, which is not kept), so with
 * orgs configured a removed member keeps access until their session expires.
 */
const stillAllowed = (access: AccessPolicy, login: string): boolean => listed(access, login) || access.orgs.length > 0

/** The caller a bearer token identifies, or null when it is missing, malformed, expired, or revoked. */
export function identify(config: AuthConfig, token: string): Identity | null {
  if (!token) return null
  if (isSessionToken(token)) {
    const { login } = config
    if (!login) return null
    const claims = readSession(login.sessionSecret, token)
    if (!claims) return null
    const user = findUser(login.usersFile, claims.sub)
    if (!user || user.disabledAt) return null
    if (user.sessionsValidAfter !== undefined && claims.iat <= user.sessionsValidAfter) return null
    if (!stillAllowed(login.access, user.login)) return null
    return { id: `user:${user.githubId}`, kind: 'user', name: user.login, githubId: user.githubId }
  }
  const key = verifyKey(config.keysFile, token)
  return key ? { id: `key:${key.id}`, kind: 'key', name: key.name } : null
}

/** The OAuth scope to ask for: org membership is only readable with `read:org` (OAuth Apps; GitHub Apps ignore scopes). */
export const loginScope = (login: LoginConfig): string => (login.access.orgs.length ? 'read:org' : '')

/**
 * Turn a GitHub token, fresh from the device or code exchange, into a session.
 * The GitHub token is used here and then dropped.
 */
export async function signIn(
  login: LoginConfig,
  githubToken: string
): Promise<{ token: string; expiresAt: string; user: { login: string } }> {
  const user = await login.github.user(githubToken)
  let allowed = listed(login.access, user.login)
  for (const org of login.access.orgs) {
    if (allowed) break
    allowed = await login.github.isOrgMember(githubToken, org)
  }
  if (!allowed) throw new AccessDenied(`GitHub user ${user.login} is not allowed on this service`)
  if (findUser(login.usersFile, user.id)?.disabledAt) throw new AccessDenied(`GitHub user ${user.login} is disabled`)
  recordLogin(login.usersFile, user.id, user.login)
  return { ...issueSession(login.sessionSecret, user.id), user: { login: user.login } }
}
