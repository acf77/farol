/**
 * Signing in with GitHub. The service exchanges a device code or an authorization
 * code for a GitHub token itself (it holds the client secret) and reads who the user
 * is. It issues its own session (see `sessions.ts`). A client that asks for GitHub
 * access (the desktop app, to call GitHub itself) also gets the GitHub token back; the
 * service keeps no GitHub token. Works with a GitHub App or an OAuth App.
 */

import type { GitHubGrant } from '../shared/github-grant'

export interface GitHubAppConfig {
  clientId: string
  /** Needed for the authorization-code flow (web and mobile); the device flow works without it. */
  clientSecret?: string
  /** Redirect URIs a web or mobile client may use with the code flow. */
  redirectUris: string[]
}

export interface GitHubUser {
  id: number
  login: string
  /** Display name, when the user set one. */
  name?: string
  avatarUrl?: string
}

export interface DeviceStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export type DevicePoll =
  | { status: 'pending'; interval?: number }
  | { status: 'denied' | 'expired' }
  | { status: 'ok'; grant: GitHubGrant }

export class GitHubError extends Error {}

type Fetch = typeof fetch

const API = 'https://api.github.com'
const WEB = 'https://github.com'

/** The grant in a token response, or undefined when GitHub sent an error instead. */
function grantFrom(body: Record<string, unknown>): GitHubGrant | undefined {
  if (typeof body.access_token !== 'string') return undefined
  const expiresIn = Number(body.expires_in)
  return {
    token: body.access_token,
    ...(expiresIn > 0 ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() } : {}),
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {})
  }
}

export class GitHub {
  constructor(
    private config: GitHubAppConfig,
    private fetchFn: Fetch = fetch
  ) {}

  private async oauth(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(`${WEB}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new GitHubError(`GitHub replied HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  }

  private async api(token: string, path: string): Promise<Response> {
    return this.fetchFn(`${API}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'farol-service'
      },
      signal: AbortSignal.timeout(15_000)
    })
  }

  /** Start the device flow; the client shows `userCode` and opens `verificationUri`. */
  async startDevice(scope: string): Promise<DeviceStart> {
    const body = await this.oauth('/login/device/code', { client_id: this.config.clientId, scope })
    if (typeof body.device_code !== 'string') throw new GitHubError(String(body.error_description ?? body.error ?? 'Device flow refused'))
    return {
      deviceCode: body.device_code,
      userCode: String(body.user_code),
      verificationUri: String(body.verification_uri),
      expiresIn: Number(body.expires_in),
      interval: Number(body.interval) || 5
    }
  }

  async pollDevice(deviceCode: string): Promise<DevicePoll> {
    const body = await this.oauth('/login/oauth/access_token', {
      client_id: this.config.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
    const grant = grantFrom(body)
    if (grant) return { status: 'ok', grant }
    switch (body.error) {
      case 'authorization_pending':
        return { status: 'pending' }
      case 'slow_down':
        return { status: 'pending', interval: Number(body.interval) || undefined }
      case 'access_denied':
        return { status: 'denied' }
      case 'expired_token':
      case 'incorrect_device_code':
        return { status: 'expired' }
      default:
        throw new GitHubError(String(body.error_description ?? body.error ?? 'GitHub sign-in failed'))
    }
  }

  /** Why the browser flow cannot use `redirectUri`, or null when it can. */
  codeFlowRefusal(redirectUri: string): string | null {
    if (!this.config.clientSecret) return 'The browser sign-in flow is not configured on this service'
    return this.config.redirectUris.includes(redirectUri) ? null : 'Redirect URI is not allowed'
  }

  /** Exchange a code from the browser flow. Check `codeFlowRefusal` first. */
  async exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<GitHubGrant> {
    const { clientId, clientSecret } = this.config
    const refusal = this.codeFlowRefusal(redirectUri)
    if (refusal || !clientSecret) throw new GitHubError(refusal ?? 'No client secret')
    const body = await this.oauth('/login/oauth/access_token', {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {})
    })
    const grant = grantFrom(body)
    if (!grant) throw new GitHubError(String(body.error_description ?? body.error ?? 'GitHub sign-in failed'))
    return grant
  }

  /** A new grant for a refresh token (GitHub App user tokens expire), or null when GitHub no longer accepts it. */
  async refresh(refreshToken: string): Promise<GitHubGrant | null> {
    const { clientId, clientSecret } = this.config
    if (!clientSecret) throw new GitHubError('Refreshing GitHub tokens is not configured on this service')
    const body = await this.oauth('/login/oauth/access_token', {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
    return grantFrom(body) ?? null
  }

  async user(token: string): Promise<GitHubUser> {
    const res = await this.api(token, '/user')
    if (!res.ok) throw new GitHubError(`Reading the GitHub user failed (HTTP ${res.status})`)
    const body = (await res.json()) as { id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown }
    if (typeof body.id !== 'number' || typeof body.login !== 'string') throw new GitHubError('GitHub returned no user')
    return {
      id: body.id,
      login: body.login,
      ...(typeof body.name === 'string' && body.name ? { name: body.name } : {}),
      ...(typeof body.avatar_url === 'string' ? { avatarUrl: body.avatar_url } : {})
    }
  }

  /** Whether the token's user is an active member of `org` (needs org members read access). */
  async isOrgMember(token: string, org: string): Promise<boolean> {
    const res = await this.api(token, `/user/memberships/orgs/${encodeURIComponent(org)}`)
    if (!res.ok) return false
    return ((await res.json()) as { state?: string }).state === 'active'
  }
}
