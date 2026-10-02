/**
 * Signing in with GitHub. The service exchanges a device code or an authorization
 * code for a GitHub token itself (it holds the client secret), reads who the user
 * is, and then drops the token: GitHub only proves identity, the service issues
 * its own session (see `sessions.ts`). Works with a GitHub App or an OAuth App.
 */

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
  | { status: 'ok'; token: string }

export class GitHubError extends Error {}

type Fetch = typeof fetch

const API = 'https://api.github.com'
const WEB = 'https://github.com'

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
    if (typeof body.access_token === 'string') return { status: 'ok', token: body.access_token }
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
  async exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<string> {
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
    if (typeof body.access_token !== 'string') {
      throw new GitHubError(String(body.error_description ?? body.error ?? 'GitHub sign-in failed'))
    }
    return body.access_token
  }

  async user(token: string): Promise<GitHubUser> {
    const res = await this.api(token, '/user')
    if (!res.ok) throw new GitHubError(`Reading the GitHub user failed (HTTP ${res.status})`)
    const body = (await res.json()) as { id?: unknown; login?: unknown }
    if (typeof body.id !== 'number' || typeof body.login !== 'string') throw new GitHubError('GitHub returned no user')
    return { id: body.id, login: body.login }
  }

  /** Whether the token's user is an active member of `org` (needs org members read access). */
  async isOrgMember(token: string, org: string): Promise<boolean> {
    const res = await this.api(token, `/user/memberships/orgs/${encodeURIComponent(org)}`)
    if (!res.ok) return false
    return ((await res.json()) as { state?: string }).state === 'active'
  }
}
