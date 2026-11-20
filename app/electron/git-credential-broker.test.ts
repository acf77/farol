import fs from 'fs'
import { describe, expect, it } from 'vitest'
import { grantCredential, releaseCredential, requestGithubToken } from './git-credential-broker'

let token: string | null = 'ghp_test'
const grant = () => grantCredential(async () => token)

describe('credential broker', () => {
  it('gives the current token once per nonce, then spends it', async () => {
    token = 'ghp_test'
    const { socket, nonce } = await grant()
    await expect(requestGithubToken(socket, nonce)).resolves.toBe('ghp_test')
    token = 'ghp_refreshed'
    const again = await grant()
    await expect(requestGithubToken(again.socket, again.nonce)).resolves.toBe('ghp_refreshed')
    await expect(requestGithubToken(socket, nonce)).resolves.toBeNull()
  })

  it('spends the nonce, so a hook that inherited it after git asked gets nothing', async () => {
    token = 'ghp_test'
    const { socket, nonce } = await grant()
    await expect(requestGithubToken(socket, nonce)).resolves.toBe('ghp_test')
    await expect(requestGithubToken(socket, nonce)).resolves.toBeNull()
  })

  it('gives nothing once the command has ended, or for an unknown nonce', async () => {
    token = 'ghp_test'
    const { socket, nonce } = await grant()
    releaseCredential(nonce)
    await expect(requestGithubToken(socket, nonce)).resolves.toBeNull()
    await expect(requestGithubToken(socket, 'wrong')).resolves.toBeNull()
  })

  it('answers nothing when there is no token', async () => {
    token = null
    const { socket, nonce } = await grant()
    await expect(requestGithubToken(socket, nonce)).resolves.toBeNull()
  })

  it('keeps one socket for the run, closed to other users', async () => {
    const [a, b] = [await grant(), await grant()]
    expect(a.socket).toBe(b.socket)
    expect(a.nonce).not.toBe(b.nonce)
    if (process.platform !== 'win32') expect(fs.statSync(a.socket).mode & 0o077).toBe(0)
  })

  it('answers nothing when the app is not listening', async () => {
    await expect(requestGithubToken('/nonexistent/farol.sock', 'n')).resolves.toBeNull()
  })
})
