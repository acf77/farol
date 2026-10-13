import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '0.1.0', quit: vi.fn() }, dialog: {} }))

import { AppUpdater, feedDir } from './update'

const ZIP = `Farol-mac-${process.arch}.zip`
const bytes = Buffer.from('new farol build')
const sha512 = createHash('sha512').update(bytes).digest('base64')
let home: string

function serve(feed: string, zip: Buffer = bytes): void {
  vi.stubGlobal('fetch', async (url: string) =>
    url.endsWith('latest-mac.yml') ? new Response(feed) : new Response(zip)
  )
}

const githubFeed = (version: string, file = ZIP): string => `version: ${version}\npath: ${file}\nsha512: ${sha512}\n`

function writeLocalFeed(version: string, withZip = true): void {
  fs.mkdirSync(feedDir(), { recursive: true })
  fs.writeFileSync(path.join(feedDir(), 'latest-mac.yml'), `version: ${version}\npath: Farol-local.zip\n`)
  if (withZip) fs.writeFileSync(path.join(feedDir(), 'Farol-local.zip'), 'local build')
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-update-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('AppUpdater', () => {
  it('downloads and verifies a newer GitHub release', async () => {
    serve(githubFeed('0.2.0'))
    expect(await new AppUpdater(() => {}).check()).toEqual({ state: 'ready', version: '0.2.0' })
    expect(fs.readFileSync(path.join(feedDir(), 'github', '0.2.0', ZIP))).toEqual(bytes)
  })

  it('rejects a zip whose checksum does not match and leaves no partial file', async () => {
    serve(githubFeed('0.2.0'), Buffer.from('tampered'))
    expect(await new AppUpdater(() => {}).check()).toMatchObject({ state: 'error' })
    expect(fs.readdirSync(path.join(feedDir(), 'github', '0.2.0'))).toEqual([])
  })

  it('falls back to a local build when the GitHub download fails', async () => {
    serve(githubFeed('0.3.0'), Buffer.from('tampered'))
    writeLocalFeed('0.2.0')
    expect(await new AppUpdater(() => {}).check()).toEqual({ state: 'ready', version: '0.2.0' })
  })

  it('ignores a release built for another architecture', async () => {
    serve(githubFeed('0.2.0', 'Farol-mac-other.zip'))
    expect(await new AppUpdater(() => {}).check()).toEqual({ state: 'idle' })
  })

  it('ignores an old local feed whose zip is gone', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    writeLocalFeed('0.1.0', false)
    expect(await new AppUpdater(() => {}).check()).toEqual({ state: 'idle' })
  })

  it('keeps a prepared update when a later check fails', async () => {
    serve(githubFeed('0.2.0'))
    const updater = new AppUpdater(() => {})
    await updater.check()
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    expect(await updater.check()).toEqual({ state: 'ready', version: '0.2.0' })
  })
})
