import { spawn } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream } from 'stream/web'
import { app, dialog } from 'electron'
import { errorMessage } from '../shared/jev'
import type { UpdateStatus } from '../shared/types'
import { parseUpdateFeed, versionAhead } from '../shared/update-feed'

/** The Release workflow publishes here; `latest-mac.yml` names the zip and its SHA-512. */
const RELEASES_URL = 'https://github.com/acf77/farol/releases'
const FEED_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

/** Same folder `scripts/publish-local.mjs` writes after `npm run dist`. */
export function feedDir(): string {
  return path.join(os.homedir(), '.farol', 'updates')
}

/** Zips downloaded from GitHub; kept apart from the local feed, which prunes its own zips. */
function downloadDir(): string {
  return path.join(feedDir(), 'github')
}

/** An update a feed offers: the zip to install and, for GitHub, where to fetch it. */
interface Source {
  version: string
  zip: string
  download?: { url: string; sha512: string }
}

/** The feed's zip inside `dir`; null unless `path:` names a plain `.zip` file there. */
function zipIn(dir: string, file: string): string | null {
  const zipName = path.basename(file)
  return zipName.endsWith('.zip') && zipName === file.replace(/^\.\/+/, '') ? path.join(dir, zipName) : null
}

function localSource(): Source | null {
  const ymlPath = path.join(feedDir(), 'latest-mac.yml')
  if (!fs.existsSync(ymlPath)) return null
  const feed = parseUpdateFeed(fs.readFileSync(ymlPath, 'utf8'))
  const zip = feed && zipIn(feedDir(), feed.file)
  if (!feed || !zip) throw new Error('Local update feed is invalid')
  return { version: feed.version, zip }
}

const isFile = (file: string): boolean => fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true

async function githubSource(): Promise<Source | null> {
  const res = await fetch(`${RELEASES_URL}/latest/download/latest-mac.yml`, {
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS)
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub update feed responded ${res.status}`)
  const feed = parseUpdateFeed(await res.text())
  // Each version gets its own folder, so fetching a newer zip never touches one already offered.
  const zip = feed && /^\d+\.\d+\.\d+[\w.+-]*$/.test(feed.version) && zipIn(path.join(downloadDir(), feed.version), feed.file)
  if (!feed?.sha512 || !zip) throw new Error('GitHub update feed is invalid')
  // Release assets are named per architecture (`Farol-mac-arm64.zip`); never install another one.
  if (!path.basename(zip).includes(`-${process.arch}.`)) return null
  const url = `${RELEASES_URL}/download/v${encodeURIComponent(feed.version)}/${encodeURIComponent(path.basename(zip))}`
  return { version: feed.version, zip, download: { url, sha512: feed.sha512 } }
}

function sha512Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')))
  })
}

/**
 * Fetch the zip unless a verified copy is already there. It lands in a `.part` file and is renamed
 * only once its checksum matches.
 */
async function download(zip: string, { url, sha512 }: NonNullable<Source['download']>): Promise<void> {
  if (fs.existsSync(zip) && (await sha512Of(zip)) === sha512) return
  fs.mkdirSync(path.dirname(zip), { recursive: true })
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok || !res.body) throw new Error(`Update download responded ${res.status}`)
  const part = `${zip}.part`
  try {
    await pipeline(Readable.fromWeb(res.body as ReadableStream), fs.createWriteStream(part))
    if ((await sha512Of(part)) !== sha512) throw new Error('Downloaded update failed its checksum')
    fs.renameSync(part, zip)
  } finally {
    fs.rmSync(part, { force: true })
  }
}

/** Best effort: drop downloaded versions other than the one holding `keep`. */
function pruneDownloads(keep: string): void {
  try {
    for (const old of fs.readdirSync(downloadDir())) {
      const dir = path.join(downloadDir(), old)
      if (dir !== path.dirname(keep)) fs.rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    // A leftover folder only costs disk space; the next prune retries.
  }
}

/** Make the source's zip installable: download a GitHub zip, or require the local one to be there. */
async function prepare({ zip, download: remote }: Source): Promise<void> {
  if (remote) await download(zip, remote)
  else if (!isFile(zip)) throw new Error(`Update zip missing (${path.basename(zip)})`)
}

function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function appBundle(): string {
  // /Applications/Farol.app/Contents/MacOS/Farol → the .app
  return path.resolve(process.execPath, '..', '..', '..')
}

export class AppUpdater {
  private status: UpdateStatus = { state: 'idle' }
  private ready: { version: string; zip: string } | null = null
  /** The check in flight; startup, the timer and the menu share it instead of downloading twice. */
  private checking: Promise<UpdateStatus> | null = null

  constructor(private emit: (s: UpdateStatus) => void) {}

  private set(status: UpdateStatus): void {
    this.status = status
    this.emit(status)
  }

  private idle(): UpdateStatus {
    this.ready = null
    this.set({ state: 'idle' })
    return this.status
  }

  private fail(message: string): UpdateStatus {
    this.set({ state: 'error', message })
    return this.status
  }

  private async offerInstall(version: string): Promise<void> {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `Farol ${version} is ready`,
      detail: 'Restart to replace the running app.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 0) this.install()
  }

  /** The newest of the GitHub release and the local `npm run dist` feed, downloaded when it comes from GitHub. */
  private async find(): Promise<UpdateStatus> {
    const results = await Promise.allSettled([Promise.resolve().then(localSource), githubSource()])
    // A prepared zip that has gone missing is dropped, so its release can be fetched again.
    if (this.ready && !isFile(this.ready.zip)) this.ready = null
    // Only a build newer than both the running app and an update already prepared replaces it.
    const floor = this.ready?.version ?? app.getVersion()
    const newer = results
      .flatMap((r) => (r.status === 'fulfilled' && r.value && versionAhead(r.value.version, floor) ? [r.value] : []))
      .sort((a, b) => Number(versionAhead(b.version, a.version)) - Number(versionAhead(a.version, b.version)))
    let failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason
    // Newest first; a GitHub download that fails falls back to an older local build.
    for (const source of newer) {
      try {
        await prepare(source)
        this.ready = { version: source.version, zip: source.zip }
        this.set({ state: 'ready', version: source.version })
        pruneDownloads(source.zip)
        return this.status
      } catch (error) {
        failure = error
      }
    }
    // Nothing newer: an update still on disk stays offered, even after an earlier error.
    if (this.ready) {
      this.set({ state: 'ready', version: this.ready.version })
      return this.status
    }
    return failure === undefined ? this.idle() : this.fail(errorMessage(failure))
  }

  async check(opts?: { informNone?: boolean }): Promise<UpdateStatus> {
    this.checking ??= this.find()
      .catch((error: unknown) => this.fail(errorMessage(error)))
      .finally(() => (this.checking = null))
    const status = await this.checking
    if (!opts?.informNone) return status
    if (status.state === 'ready') await this.offerInstall(status.version)
    else if (status.state === 'error') await dialog.showMessageBox({ type: 'warning', message: status.message })
    else {
      await dialog.showMessageBox({
        type: 'info',
        message: 'You’re up to date',
        detail: `Farol ${app.getVersion()} is the latest release.`
      })
    }
    return status
  }

  install(): void {
    if (!this.ready) return
    if (process.platform !== 'darwin') {
      this.set({ state: 'error', message: 'In-place updates are only wired for macOS' })
      return
    }

    const dest = appBundle()
    const tmp = path.join(os.tmpdir(), `farol-update-${Date.now()}`)
    // The script unzips after the app has quit; a private copy cannot be pruned or replaced meanwhile.
    const zip = path.join(tmp, path.basename(this.ready.zip))
    try {
      fs.mkdirSync(tmp, { recursive: true })
      fs.copyFileSync(this.ready.zip, zip)
    } catch (error) {
      fs.rmSync(tmp, { recursive: true, force: true })
      this.fail(`Could not stage the update: ${errorMessage(error)}`)
      return
    }

    const script = path.join(os.tmpdir(), `farol-apply-update-${Date.now()}.sh`)
    fs.writeFileSync(
      script,
      `#!/bin/bash
set -e
SRC_ZIP=${sh(zip)}
TMP=${sh(tmp)}
DEST=${sh(dest)}
/usr/bin/ditto -xk "$SRC_ZIP" "$TMP"
NEW=$(/usr/bin/find "$TMP" -name '*.app' -maxdepth 3 | /usr/bin/head -n 1)
if [ -z "$NEW" ]; then
  echo "farol: unzipped update has no .app" >&2
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
