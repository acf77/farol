import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildManifest, clearHashCache } from './snapshot-manifest'

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex')

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-manifest-'))
  clearHashCache()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function write(rel: string, body: string, mode = 0o644) {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, { mode })
  fs.chmodSync(file, mode)
}

describe('buildManifest', () => {
  it('describes files, modes and symlinks by content hash', async () => {
    write('a.txt', 'one')
    write('src/run.sh', '#!/bin/sh', 0o755)
    fs.symlinkSync('a.txt', path.join(dir, 'link'))
    const m = await buildManifest(dir, { files: ['a.txt', 'src/run.sh', 'link'], pipelinesRoot: null })
    expect(m.entries).toEqual([
      { path: 'a.txt', sha: sha('one'), size: 3, mode: 0o644 },
      { path: 'src/run.sh', sha: sha('#!/bin/sh'), size: 9, mode: 0o755 },
      { path: 'link', link: 'a.txt' }
    ])
    expect(m.totalBytes).toBe(12)
  })

  it('names one path per distinct content, and skips files that vanished', async () => {
    write('x.txt', 'same')
    write('y.txt', 'same')
    const m = await buildManifest(dir, { files: ['x.txt', 'y.txt', 'gone.txt'], pipelinesRoot: null })
    expect(m.entries.map((e) => e.path)).toEqual(['x.txt', 'y.txt'])
    expect([...m.pathBySha]).toEqual([[sha('same'), 'x.txt']])
  })

  it('takes the pipelines file from the primary checkout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-primary-'))
    try {
      fs.mkdirSync(path.join(root, '.farol'))
      fs.writeFileSync(path.join(root, '.farol/pipelines.json'), '[]')
      write('a.txt', 'one')
      const m = await buildManifest(dir, { files: ['a.txt'], pipelinesRoot: root })
      expect(m.entries.find((e) => e.path === '.farol/pipelines.json')).toMatchObject({ sha: sha('[]'), size: 2 })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rehashes an edited file', async () => {
    write('a.txt', 'one')
    const plan = { files: ['a.txt'], pipelinesRoot: null }
    const before = await buildManifest(dir, plan)
    write('a.txt', 'two!')
    const after = await buildManifest(dir, plan)
    expect(before.entries[0].sha).toBe(sha('one'))
    expect(after.entries[0].sha).toBe(sha('two!'))
  })
})
