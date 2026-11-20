/**
 * Gives the GitHub token to Farol's git-credential helper over a local socket (plain Node cannot
 * read the encrypted store). Each git command gets a one-use nonce; git spends it when listing
 * refs, before pre-push, so hooks that inherit the env cannot reuse it. No Electron imports here.
 */

import { randomBytes } from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'

export const CREDENTIAL_SOCKET_ENV = 'FAROL_GIT_CREDENTIAL_SOCKET'
export const CREDENTIAL_NONCE_ENV = 'FAROL_GIT_CREDENTIAL_NONCE'

/** The helper waits this long for the app before it gives up and lets git fall back. */
const REQUEST_TIMEOUT_MS = 5_000
/** A request is one short line; anything longer is not from the helper. */
const MAX_REQUEST_BYTES = 256

/** Nonces handed to a git command that has not asked for its token yet. */
const grants = new Set<string>()

let readToken: (() => Promise<string | null>) | undefined
let socketPath: Promise<string> | undefined

function serve(): Promise<string> {
  const dir = process.platform === 'win32' ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'farol-cred-'))
  const socket = dir ? path.join(dir, 's') : `\\\\.\\pipe\\farol-cred-${randomBytes(6).toString('hex')}`

  const server = net.createServer((conn) => {
    let received = ''
    conn.setTimeout(REQUEST_TIMEOUT_MS, () => conn.destroy())
    conn.on('error', () => conn.destroy())
    conn.on('data', (chunk) => {
      received += chunk.toString('utf8')
      if (received.length > MAX_REQUEST_BYTES) return void conn.destroy()
      const end = received.indexOf('\n')
      if (end < 0) return
      conn.removeAllListeners('data')
      // Spent on first use, so a later caller holding the same nonce gets nothing.
      if (!grants.delete(received.slice(0, end))) return void conn.destroy()
      const getToken = readToken
      if (!getToken) return void conn.destroy()
      getToken().then(
        (token) => conn.end(token ? `${token}\n` : ''),
        () => conn.destroy()
      )
    })
  })
  server.unref()
  process.once('exit', () => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, () => {
      if (dir) fs.chmodSync(socket, 0o600)
      resolve(socket)
    })
  })
}

/**
 * Lets one git command ask the app for the token once. `getToken` runs at that request, so a refreshed
 * token is used. Pass the nonce to `releaseCredential` when the command ends.
 */
export async function grantCredential(
  getToken: () => Promise<string | null>
): Promise<{ socket: string; nonce: string }> {
  readToken = getToken
  socketPath ??= serve().catch((error) => {
    socketPath = undefined
    throw error
  })
  const socket = await socketPath
  const nonce = randomBytes(32).toString('hex')
  grants.add(nonce)
  return { socket, nonce }
}

/** End a git command's grant, whether or not git used it. */
export function releaseCredential(nonce: string | undefined): void {
  if (nonce) grants.delete(nonce)
}

/** What the helper calls: the token from the app, or null when the app has none, refuses, or does not answer. */
export function requestGithubToken(socket: string, nonce: string): Promise<string | null> {
  return new Promise((resolve) => {
    let reply = ''
    const conn = net.connect(socket)
    const finish = (): void => {
      conn.destroy()
      resolve(reply.trim() || null)
    }
    conn.setTimeout(REQUEST_TIMEOUT_MS, finish)
    conn.on('connect', () => conn.write(`${nonce}\n`))
    conn.on('data', (chunk) => (reply += chunk.toString('utf8')))
    conn.on('end', finish)
    conn.on('error', () => {
      reply = ''
      finish()
    })
  })
}
