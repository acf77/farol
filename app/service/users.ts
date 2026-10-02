import fs from 'fs'
import path from 'path'

/**
 * People who signed in with GitHub, keyed by GitHub's numeric id (a login can be
 * renamed). Like the API key file, it is re-read on every check, so disabling a
 * user or revoking their sessions takes effect immediately.
 */

export interface UserRecord {
  githubId: number
  login: string
  createdAt: string
  lastLoginAt: string
  disabledAt?: string
  /** Sessions issued before this time (unix seconds) are no longer accepted. */
  sessionsValidAfter?: number
}

function readUsers(file: string): UserRecord[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as UserRecord[]) : []
  } catch {
    return []
  }
}

function writeUsers(file: string, users: UserRecord[]): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Record a sign-in: create the user, or refresh their login name and last sign-in time. */
export function recordLogin(file: string, githubId: number, login: string): UserRecord {
  const users = readUsers(file)
  const now = new Date().toISOString()
  let user = users.find((u) => u.githubId === githubId)
  if (user) Object.assign(user, { login, lastLoginAt: now })
  else users.push((user = { githubId, login, createdAt: now, lastLoginAt: now }))
  writeUsers(file, users)
  return user
}

export function findUser(file: string, githubId: number): UserRecord | undefined {
  return readUsers(file).find((u) => u.githubId === githubId)
}

export function listUsers(file: string): UserRecord[] {
  return readUsers(file)
}

/** A user given as GitHub id, or as login (case-insensitive). */
type UserRef = number | string

const matches = (user: UserRecord, ref: UserRef): boolean =>
  typeof ref === 'number' ? user.githubId === ref : user.login.toLowerCase() === ref.toLowerCase()

/** Apply `change` to the referenced user. Returns false when there is none. */
function update(file: string, ref: UserRef, change: (user: UserRecord) => void): boolean {
  const users = readUsers(file)
  const user = users.find((u) => matches(u, ref))
  if (!user) return false
  change(user)
  writeUsers(file, users)
  return true
}

/** End every session the user holds now; they can sign in again. */
export function revokeSessions(file: string, ref: UserRef): boolean {
  return update(file, ref, (user) => (user.sessionsValidAfter = Math.floor(Date.now() / 1000)))
}

/** Block the user: their sessions stop working and they cannot sign in again. */
export function disableUser(file: string, ref: UserRef): boolean {
  return update(file, ref, (user) => (user.disabledAt = new Date().toISOString()))
}

export function enableUser(file: string, ref: UserRef): boolean {
  return update(file, ref, (user) => delete user.disabledAt)
}
