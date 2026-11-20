/**
 * Git credential helper for https://github.com. Git may run it while it lists refs,
 * before a pre-push hook; the broker nonce is one-use so a hook cannot reuse it.
 * The token stays out of GIT_CONFIG_VALUE_* and the command line; plain Node asks
 * the app on a socket (`git-credential-broker.ts`).
 */

import readline from 'readline'
import { CREDENTIAL_NONCE_ENV, CREDENTIAL_SOCKET_ENV, requestGithubToken } from './git-credential-broker'

/** Git credential protocol body for github.com, or undefined when this helper should stay silent. */
export function githubCredentialLines(
  host: string,
  token: string | null,
  protocol = 'https'
): string | undefined {
  if (host !== 'github.com' || !token) return undefined
  return `username=x-access-token\npassword=${token}\nprotocol=${protocol}\nhost=github.com\n\n`
}

async function readFields(): Promise<Record<string, string>> {
  const fields: Record<string, string> = {}
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) break
    const eq = line.indexOf('=')
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1)
  }
  rl.close()
  return fields
}

async function main(): Promise<void> {
  const op = process.argv[2]
  if (op !== 'get') return
  const fields = await readFields()
  const socket = process.env[CREDENTIAL_SOCKET_ENV]
  const nonce = process.env[CREDENTIAL_NONCE_ENV]
  const token = fields.host === 'github.com' && socket && nonce ? await requestGithubToken(socket, nonce) : null
  const lines = githubCredentialLines(fields.host ?? '', token, fields.protocol ?? 'https')
  if (!lines) process.exit(fields.host === 'github.com' ? 1 : 0)
  process.stdout.write(lines)
}

main().catch(() => process.exit(1))