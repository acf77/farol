/**
 * Preloaded by `bun run bench`: the bench runs Farol's main-process code
 * outside Electron, so the few `electron` imports on its path get a stand-in.
 * User data goes to a fresh temp folder, which also keeps the developer's saved
 * keys out of the run: Jev, which needs one, stays off, and so does every
 * provider key Farol would otherwise put in the agent's environment. The agent
 * CLI's own login is what runs it.
 */

import { plugin } from 'bun'
import fs from 'fs'
import os from 'os'
import path from 'path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-bench-userdata-'))
process.on('exit', () => fs.rmSync(userData, { recursive: true, force: true }))

plugin({
  name: 'farol-bench-electron',
  setup(build) {
    build.module('electron', () => ({
      loader: 'object',
      exports: {
        app: {
          getPath: () => userData,
          getVersion: () => '0.0.0-bench',
          getName: () => 'Farol Bench',
          isPackaged: false,
          on: () => undefined,
          whenReady: () => Promise.resolve()
        },
        safeStorage: {
          isEncryptionAvailable: () => false,
          encryptString: (text: string) => Buffer.from(text),
          decryptString: (data: Buffer) => data.toString()
        },
        shell: { openExternal: async () => undefined }
      }
    }))
  }
})
