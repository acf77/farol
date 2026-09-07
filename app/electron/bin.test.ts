import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { extraBinDirs, resolveBin } from './bin'

const dirs: string[] = []

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-bin-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('extraBinDirs', () => {
  it('includes OpenCode default install location', () => {
    const home = os.homedir()
    expect(extraBinDirs()).toContain(path.join(home, '.opencode', 'bin'))
  })
})

describe('resolveBin', () => {
  it('finds executables in extra bin dirs', () => {
    const binDir = path.join(tmp(), '.opencode', 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    const binPath = path.join(binDir, 'opencode')
    fs.writeFileSync(binPath, '#!/bin/sh\necho ok\n', { mode: 0o755 })

    expect(resolveBin('opencode', [binDir])).toBe(binPath)
  })
})
