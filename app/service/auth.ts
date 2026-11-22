import type { GitHubGrant } from '../shared/github-grant'
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
  /** GitHub display name and avatar, for `user` identities. */
  displayName?: string
  avatarUrl?: string
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
 * only checked at sign-in (it needs the GitHub token, which the service does not keep), so with
 * orgs configured a removed member keeps access until their session expires.
 */
const stillAllowed = (access: AccessPolicy, login: string): boolean => listed(access, login) || access.orgs.length > 0

function identityFromSession(config: AuthConfig, token: string): Identity | null {
  const { login } = config
  if (!login) return null
  const claims = readSession(login.sessionSecret, token)
  if (!claims) return null
  const user = findUser(login.usersFile, claims.sub)
  if (!user || user.disabledAt) return null
  if (user.sessionsValidAfter !== undefined && claims.iat <= user.sessionsValidAfter) return null
  if (!stillAllowed(login.access, user.login)) return null
  return {
    id: `user:${user.githubId}`,
    kind: 'user',
    name: user.login,
    githubId: user.githubId,
    ...(user.name ? { displayName: user.name } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {})
  }
}

/** The caller a bearer token identifies, or null when it is missing, malformed, expired, or revoked. */
export function identify(config: AuthConfig, token: string): Identity | null {
  if (!token) return null
  if (isSessionToken(token)) return identityFromSession(config, token)
  const key = verifyKey(config.keysFile, token)
  return key ? { id: `key:${key.id}`, kind: 'key', name: key.name } : null
}

/**
 * The OAuth scopes to ask for (OAuth Apps; GitHub Apps ignore scopes): `repo` only for a client
 * that asked for GitHub access, because it lets that client use the GitHub API as the user, and
 * `read:org`, the only way to read org membership. A client that did not ask gets neither more
 * than it needs nor a token it never wanted.
 */
export const loginScope = (login: Pick<LoginConfig, 'access'>, githubAccess: boolean): string =>
  [...(githubAccess ? ['repo'] : []), ...(login.access.orgs.length ? ['read:org'] : [])].join(' ')

/**
 * Turn a GitHub grant, fresh from the device or code exchange, into a session.
 * The service checks who signed in and keeps no GitHub token: the grant goes back to the
 * caller, which passes it on only to a client that asked for it.
 */
export async function signIn(
  login: LoginConfig,
  github: GitHubGrant
): Promise<{
  token: string
  expiresAt: string
  user: { login: string; name?: string; avatarUrl?: string }
  github: GitHubGrant
}> {
  const user = await login.github.user(github.token)
  let allowed = listed(login.access, user.login)
  for (const org of login.access.orgs) {
    if (allowed) break
    allowed = await login.github.isOrgMember(github.token, org)
  }
  if (!allowed) throw new AccessDenied(`GitHub user ${user.login} is not allowed on this service`)
  if (findUser(login.usersFile, user.id)?.disabledAt) throw new AccessDenied(`GitHub user ${user.login} is disabled`)
  recordLogin(login.usersFile, user.id, user)
  const { login: name, name: displayName, avatarUrl } = user
  return { ...issueSession(login.sessionSecret, user.id), user: { login: name, name: displayName, avatarUrl }, github }
}

/**
 * Trade a GitHub refresh token for a new grant. The new token must belong to `githubId`, so a
 * caller cannot refresh someone else's token. Returns null when GitHub no longer accepts it.
 */
export async function refreshGrant(login: Pick<LoginConfig, 'github'>, githubId: number, refreshToken: string): Promise<GitHubGrant | null> {
  const grant = await login.github.refresh(refreshToken)
  if (!grant) return null
  if ((await login.github.user(grant.token)).id !== githubId) throw new AccessDenied('That refresh token belongs to another GitHub account')
  return grant
}
