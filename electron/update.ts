import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app, dialog } from 'electron'
import type { UpdateStatus } from '../shared/types'
import { parseUpdateFeed, versionAhead } from '../shared/update-feed'

/** Same folder `scripts/publish-local.mjs` writes after `npm run dist`. */
export function feedDir(): string {
  return path.join(os.homedir(), '.buildflow', 'updates')
}

function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function appBundle(): string {
  // /Applications/BuildFlow.app/Contents/MacOS/BuildFlow → the .app
  return path.resolve(process.execPath, '..', '..', '..')
}

export class AppUpdater {
  private status: UpdateStatus = { state: 'idle' }
  private ready: { version: string; zip: string } | null = null

  constructor(private emit: (s: UpdateStatus) => void) {}

  private set(status: UpdateStatus): void {
    this.status = status
    this.emit(status)
  }

  async check(opts?: { informNone?: boolean }): Promise<UpdateStatus> {
    const ymlPath = path.join(feedDir(), 'latest-mac.yml')
    if (!fs.existsSync(ymlPath)) {
      this.ready = null
      this.set({ state: 'idle' })
      if (opts?.informNone) {
        await dialog.showMessageBox({
          type: 'info',
          message: 'No update available',
          detail: 'Build a new version with npm run dist. It will show up here.'
        })
      }
      return this.status
    }

    const feed = parseUpdateFeed(fs.readFileSync(ymlPath, 'utf8'))
    if (!feed) {
      this.set({ state: 'error', message: 'Update feed is unreadable' })
      return this.status
    }

    const zipName = path.basename(feed.file)
    if (!zipName || zipName !== feed.file.replace(/^\.\/+/, '')) {
      this.set({ state: 'error', message: 'Update feed path is invalid' })
      return this.status
    }
    const zip = path.join(feedDir(), zipName)
    if (path.dirname(path.resolve(zip)) !== path.resolve(feedDir())) {
      this.set({ state: 'error', message: 'Update feed path is invalid' })
      return this.status
    }
    if (!versionAhead(feed.version, app.getVersion())) {
      this.ready = null
      this.set({ state: 'idle' })
      if (opts?.informNone) {
        await dialog.showMessageBox({
          type: 'info',
          message: 'You’re up to date',
          detail: `BuildFlow ${app.getVersion()} is the latest build.`
        })
      }
      return this.status
    }

    if (!fs.existsSync(zip)) {
      this.set({ state: 'error', message: `Update zip missing (${feed.file})` })
      if (opts?.informNone) {
        await dialog.showMessageBox({ type: 'warning', message: this.status.state === 'error' ? this.status.message : 'Update failed' })
      }
      return this.status
    }

    this.ready = { version: feed.version, zip }
    this.set({ state: 'ready', version: feed.version })
    if (opts?.informNone) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        message: `BuildFlow ${feed.version} is ready`,
        detail: 'Restart to replace the running app.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1
      })
      if (response === 0) this.install()
    }
    return this.status
  }

  install(): void {
    if (!this.ready) return
    if (process.platform !== 'darwin') {
      this.set({ state: 'error', message: 'In-place updates are only wired for macOS' })
      return
    }

    const pack = this.ready
    const dest = appBundle()
    const tmp = path.join(os.tmpdir(), `buildflow-update-${Date.now()}`)
    fs.mkdirSync(tmp, { recursive: true })

    const script = path.join(os.tmpdir(), `buildflow-apply-update-${Date.now()}.sh`)
    fs.writeFileSync(
      script,
      `#!/bin/bash
set -e
SRC_ZIP=${sh(pack.zip)}
TMP=${sh(tmp)}
DEST=${sh(dest)}
/usr/bin/ditto -xk "$SRC_ZIP" "$TMP"
NEW=$(/usr/bin/find "$TMP" -name '*.app' -maxdepth 3 | /usr/bin/head -n 1)
if [ -z "$NEW" ]; then
  echo "buildflow: unzipped update has no .app" >&2
  exit 1
fi
for i in 1 2 3 4 5 6 7 8 9 10; do
  if ! /usr/bin/pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1; then break; fi
  sleep 0.3
done
rm -rf "$DEST"
/usr/bin/ditto "$NEW" "$DEST"
xattr -cr "$DEST" >/dev/null 2>&1 || true
rm -rf "$TMP"
open -a "$DEST"
rm -f "$0"
`,
      { mode: 0o755 }
    )

    spawn(script, [], { detached: true, stdio: 'ignore' }).unref()
    app.quit()
  }
}
