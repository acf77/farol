/**
 * Stands in for the `electron` module when the backend runs headless on a
 * Remote machine (`server.ts`, bundled with `electron` aliased here). Only the
 * pieces the backend's helpers touch are provided.
 *
 * - `app.getPath('userData')` is the server's data directory.
 * - `safeStorage` reports no encryption, so `secrets.ts` holds no keys there:
 *   provider keys stay on the desktop, and agents on the remote use the logins
 *   their own CLIs keep on that machine.
 * - Anything that would open UI fails, since there is nobody to show it to.
 */
import os from 'os'
import path from 'path'

declare const __FAROL_VERSION__: string

const dataDir = (): string => process.env.FAROL_SERVER_DATA || path.join(os.homedir(), '.farol-server', 'data')

export const app = {
  getPath: (_name: string): string => dataDir(),
  getVersion: (): string => (typeof __FAROL_VERSION__ === 'string' ? __FAROL_VERSION__ : 'dev'),
  getAppPath: (): string => __dirname,
  isPackaged: true,
  quit: (): void => process.exit(0)
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (): Buffer => {
    throw new Error('Keys are kept on the desktop, not on the remote machine.')
  },
  decryptString: (): string => {
    throw new Error('Keys are kept on the desktop, not on the remote machine.')
  }
}

export const shell = {
  openExternal: async (): Promise<void> => {
    throw new Error('The remote machine has no browser to open.')
  }
}

export const dialog = {
  showMessageBox: async (): Promise<{ response: number }> => ({ response: 0 })
}
