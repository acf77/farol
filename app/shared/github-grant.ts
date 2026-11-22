/**
 * What a GitHub sign-in gives back. The service hands it to the client that completed
 * the sign-in and keeps nothing; the desktop app uses it to call the GitHub API.
 * GitHub App user tokens expire and come with a refresh token; OAuth App tokens do neither.
 */
export interface GitHubGrant {
  token: string
  /** ISO time the token stops working, for tokens that expire. */
  expiresAt?: string
  refreshToken?: string
}
