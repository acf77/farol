/**
 * Keeps a credentialed git command's hooks from seeing its credential grant. Git passes its
 * environment to every hook, and git may log in without Farol's helper (a login in the remote
 * URL, an `http.extraHeader`), leaving the one-use nonce unspent while `pre-push` runs. Each
 * hook is run through a shim that drops the grant first, then runs the real hook.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { quoteShellArg } from '../shared/graph'
import { CREDENTIAL_NONCE_ENV, CREDENTIAL_SOCKET_ENV } from './git-credential-broker'

export interface ShieldedHooks {
  /** Git arguments that make git run the shims. */
  args: string[]
  cleanup(): void
}

/** `hooks` are the hooks git would run for the repository, as `hooksInfo` lists them. */
export function shieldHooks(hooks: { name: string; path: string; enabled: boolean }[]): ShieldedHooks {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-hooks-'))
  for (const hook of hooks.filter((h) => h.enabled)) {
    const shim = `#!/bin/sh\nunset ${CREDENTIAL_SOCKET_ENV} ${CREDENTIAL_NONCE_ENV}\nexec ${quoteShellArg(hook.path)} "$@"\n`
    fs.writeFileSync(path.join(dir, hook.name), shim, { mode: 0o755 })
  }
  return { args: ['-c', `core.hooksPath=${dir}`], cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
