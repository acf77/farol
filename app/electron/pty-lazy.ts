/**
 * `node-pty` for the headless server (`server.ts`, bundled with `node-pty`
 * aliased here). The remote machine installs node-pty when Farol sets the
 * server up; if that failed (no compiler, say), the server still runs and
 * only terminal panes and pipeline steps report why they cannot start.
 */
import { createRequire } from 'module'
import os from 'os'
import type * as Pty from 'node-pty'

let real: typeof Pty | null = null

function load(): typeof Pty {
  if (real) return real
  try {
    // Built at runtime so the bundler leaves this lookup to Node.
    real = createRequire(__filename)('node-pty') as typeof Pty
    return real
  } catch (err) {
    const where = __dirname.replace(os.homedir(), '~')
    throw new Error(
      `Terminals and pipeline steps need node-pty on the remote machine, and it is not installed. ` +
        `Install build tools (python3, make, a C++ compiler), then run \`npm install\` in ${where}. ` +
        `Details: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    )
  }
}

export const spawn: typeof Pty.spawn = (file, args, options) => load().spawn(file, args, options)
