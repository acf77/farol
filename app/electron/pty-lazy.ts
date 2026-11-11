/**
 * `node-pty` for the headless server (`server.ts`, bundled with `node-pty`
 * aliased here). On a Remote machine the server installs a fork of node-pty
 * that ships prebuilt Linux binaries, with the same API. If that install
 * failed, the server still runs and only terminal panes and pipeline steps
 * report why they cannot start.
 */
import { createRequire } from 'module'
import os from 'os'
import type * as Pty from 'node-pty'

let real: typeof Pty | null = null

function load(): typeof Pty {
  if (real) return real
  try {
    // Built at runtime so the bundler leaves these lookups to Node.
    const requireHere = createRequire(__filename)
    try {
      real = requireHere('@homebridge/node-pty-prebuilt-multiarch') as typeof Pty
    } catch {
      real = requireHere('node-pty') as typeof Pty
    }
    return real
  } catch (err) {
    const where = __dirname.replace(os.homedir(), '~')
    throw new Error(
      `Terminals and pipeline steps need the terminal library on the remote machine, and it did not install. ` +
        `See npm-install.log in ${where}. ` +
        `Details: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    )
  }
}

export const spawn: typeof Pty.spawn = (file, args, options) => load().spawn(file, args, options)
