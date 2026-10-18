import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listGitFiles, runGitToArtifact } from './git-artifact'

let root: string
let cwd: string
let outside: string
const signal = new AbortController().signal

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-git-artifact-'))
  cwd = path.join(root, 'checkout')
  outside = path.join(root, 'outside')
  fs.mkdirSync(cwd)
  fs.mkdirSync(outside)
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('runGitToArtifact', () => {
  it('writes the output and a .gitignore that hides the folder', async () => {
    const result = await runGitToArtifact(cwd, ['--version'], '.farol/git/v.txt', signal)
    const file = fs.readFileSync(path.join(cwd, '.farol/git/v.txt'), 'utf8')
    expect(file).toMatch(/^git version/)
    expect(result).toEqual({ preview: file, truncated: false })
    expect(fs.readFileSync(path.join(cwd, '.farol/git/.gitignore'), 'utf8')).toBe('*\n')
  })

  it('streams all of a huge output to the file and keeps only a preview', async () => {
    const big = 'line of text\n'.repeat(300_000)
    execFileSync('git', ['init', '-q'], { cwd })
    fs.writeFileSync(path.join(cwd, 'big.txt'), big)
    const blob = execFileSync('git', ['hash-object', '-w', 'big.txt'], { cwd, encoding: 'utf8' }).trim()

    const result = await runGitToArtifact(cwd, ['cat-file', '-p', blob], '.farol/git/big.txt', signal)

    expect(fs.readFileSync(path.join(cwd, '.farol/git/big.txt'), 'utf8')).toBe(big)
    expect(result.truncated).toBe(true)
    expect(result.preview).toBe(big.slice(0, 100_000))
  })

  it('lists the names git prints', async () => {
    execFileSync('git', ['init', '-q'], { cwd })
    fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=1')
    fs.writeFileSync(path.join(cwd, 'a b.txt'), 'x')
    execFileSync('git', ['add', '.'], { cwd })
    expect(await listGitFiles(cwd, ['ls-files', '-z'], signal)).toEqual(['.env', 'a b.txt'])
  })

  it('rejects with stderr and the exit code when git fails', async () => {
    await expect(runGitToArtifact(cwd, ['rev-parse', '--verify', 'nope'], '.farol/git/x.txt', signal)).rejects.toMatchObject({
      code: 128,
      stderr: expect.stringContaining('fatal')
    })
  })

  it('refuses a symlinked folder', async () => {
    fs.symlinkSync(outside, path.join(cwd, '.farol'))
    await expect(runGitToArtifact(cwd, ['--version'], '.farol/git/v.txt', signal)).rejects.toThrow(/real folder/)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('refuses a symlinked result file', async () => {
    fs.mkdirSync(path.join(cwd, '.farol/git'), { recursive: true })
    fs.writeFileSync(path.join(outside, 'target'), 'keep')
    fs.symlinkSync(path.join(outside, 'target'), path.join(cwd, '.farol/git/v.txt'))
    await expect(runGitToArtifact(cwd, ['--version'], '.farol/git/v.txt', signal)).rejects.toThrow()
    expect(fs.readFileSync(path.join(outside, 'target'), 'utf8')).toBe('keep')
  })
})
