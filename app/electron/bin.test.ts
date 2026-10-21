import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./secrets', () => ({ peekSecret: () => 'sk-or-test' }))
vi.mock('./session', () => ({ shellEnv: () => ({ PATH: '/usr/bin' }) }))

import { aiEnv, extraBinDirs, interactiveAiEnv, resolveBin } from './bin'
import { setProviderKeysOff } from './provider-keys-off'

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
    expect(extraBinDirs()).toContain(path.join(home, '.volta', 'bin'))
    expect(extraBinDirs()).toContain(path.join(home, '.fnm', 'aliases', 'default', 'bin'))
  })
})

describe('extraBinDirs with nvm', () => {
  const nvmDir = process.env.NVM_DIR

  afterEach(() => {
    if (nvmDir === undefined) delete process.env.NVM_DIR
    else process.env.NVM_DIR = nvmDir
  })

  it('lists installed nvm Node versions newest first', () => {
    const root = tmp()
    for (const v of ['v22.23.2', 'v9.0.0', 'v25.1.0']) fs.mkdirSync(path.join(root, 'versions', 'node', v, 'bin'), { recursive: true })
    process.env.NVM_DIR = root

    const dirs = extraBinDirs().filter((dir) => dir.startsWith(root))
    expect(dirs).toContain(path.join(root, 'versions', 'node', 'v25.1.0', 'bin'))
    expect(dirs.indexOf(path.join(root, 'versions', 'node', 'v25.1.0', 'bin'))).toBeLessThan(
      dirs.indexOf(path.join(root, 'versions', 'node', 'v22.23.2', 'bin'))
    )
    expect(dirs.indexOf(path.join(root, 'versions', 'node', 'v22.23.2', 'bin'))).toBeLessThan(
      dirs.indexOf(path.join(root, 'versions', 'node', 'v9.0.0', 'bin'))
    )
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

describe('aiEnv', () => {
  it('isolates OpenCode data only when OpenRouter rides OpenCode', () => {
    const viaOpencode = aiEnv('openrouter')
    expect(viaOpencode.OPENROUTER_API_KEY).toBe('sk-or-test')
    expect(viaOpencode.XDG_DATA_HOME).toContain('farol-opencode')

    const viaPi = aiEnv('openrouter', 'pi')
    expect(viaPi.OPENROUTER_API_KEY).toBe('sk-or-test')
    expect(viaPi.XDG_DATA_HOME).toBeUndefined()

    expect(aiEnv('opencode', 'pi').XDG_DATA_HOME).toContain('farol-opencode')
    expect(aiEnv('omp').OPENROUTER_API_KEY).toBeUndefined()
  })
})

describe('aiEnv vendor keys', () => {
  afterEach(() => setProviderKeysOff([]))

  it('passes the stored key to Claude and both Codex variables', () => {
    expect(aiEnv('claude').ANTHROPIC_API_KEY).toBe('sk-or-test')
    expect(aiEnv('codex').OPENAI_API_KEY).toBe('sk-or-test')
    expect(aiEnv('codex').CODEX_API_KEY).toBe('sk-or-test')
  })

  it('gives the interactive Codex terminal no key but keeps Claude\'s', () => {
    expect(interactiveAiEnv('codex').OPENAI_API_KEY).toBeUndefined()
    expect(interactiveAiEnv('codex').CODEX_API_KEY).toBeUndefined()
    expect(interactiveAiEnv('claude').ANTHROPIC_API_KEY).toBe('sk-or-test')
  })

  it('omits the key when switched off', () => {
    setProviderKeysOff(['anthropic'])
    expect(aiEnv('claude').ANTHROPIC_API_KEY).toBeUndefined()
    expect(aiEnv('codex').OPENAI_API_KEY).toBe('sk-or-test')
  })
})
