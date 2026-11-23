/** A fresh checkout of the fixture for one run: a Git repo with a local `origin` to push to. */

import { execFileSync, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { scopedRuntimeId } from '../shared/runtime'
import type { Pipeline } from '../shared/types'
import { DEFAULT_PIPELINES, FIXTURE_FILES, FIXTURE_PIPELINES } from './fixture'
import type { BenchCase } from './types'

export interface Workspace {
  /** Holds the checkout and its remote; removed by `dispose`. */
  dir: string
  /** The checkout the agent works in. */
  repo: string
  /** The commit the case starts from. */
  base: string
  branch: string
  /** The pipelines offered, with the ids managed Chat gives them (`repo-…:managed-pipeline:<id>`). */
  catalog: Pipeline[]
  /** Catalog id → bare id. */
  bareIds: Map<string, string>
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function write(repo: string, rel: string, text: string): void {
  const file = path.join(repo, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** The pipelines a case offers, as `.farol/pipelines.json` holds them (bare ids). */
export function casePipelines(c: BenchCase): Pipeline[] {
  return (c.pipelines ?? DEFAULT_PIPELINES).map((id) => {
    const pipeline = FIXTURE_PIPELINES[id]
    if (!pipeline) throw new Error(`${c.id}: unknown fixture pipeline ${id}`)
    return pipeline
  })
}

export function createWorkspace(c: BenchCase, root: string): Workspace {
  fs.mkdirSync(root, { recursive: true })
  const dir = fs.mkdtempSync(path.join(root, `${c.id.replace(/[^a-z0-9]+/gi, '-')}-`))
  const repo = path.join(dir, 'tally')
  const origin = path.join(dir, 'origin.git')
  fs.mkdirSync(repo)

  const files = { ...FIXTURE_FILES, ...(c.files ?? {}) }
  for (const [rel, text] of Object.entries(files)) if (text !== null) write(repo, rel, text)
  const pipelines = casePipelines(c)
  write(repo, '.farol/pipelines.json', `${JSON.stringify(pipelines, null, 2)}\n`)
  write(repo, '.farol/.gitignore', 'last-failure.md\n')

  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'bench@farol.invalid')
  git(repo, 'config', 'user.name', 'Farol Bench')
  git(repo, 'config', 'commit.gpgsign', 'false')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'Initial commit')
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  const branch = c.git?.branch ?? 'main'
  if (branch !== 'main') git(repo, 'checkout', '-q', '-b', branch)

  for (const [hook, cmd] of Object.entries(c.git?.hooks ?? {})) {
    const file = path.join(repo, '.git', 'hooks', hook)
    fs.writeFileSync(file, `#!/bin/sh\nexec ${cmd}\n`)
    fs.chmodSync(file, 0o755)
  }

  const bareIds = new Map<string, string>()
  const catalog = pipelines.map((pipeline) => {
    const id = scopedRuntimeId(repo, `managed-pipeline:${pipeline.id}`)
    bareIds.set(id, pipeline.id)
    return { ...pipeline, id }
  })
  return { dir, repo, base: git(repo, 'rev-parse', 'HEAD'), branch, catalog, bareIds }
}

export function disposeWorkspace(ws: Workspace): void {
  fs.rmSync(ws.dir, { recursive: true, force: true })
}

export interface ShellResult {
  code: number
  output: string
}

/** Run `cmd` through `sh -c` in `cwd`, stdout and stderr interleaved, killed after `timeoutMs`. */
export function sh(cmd: string, cwd: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let output = ''
    const add = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-64_000)
    }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    const kill = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    const timer = setTimeout(() => {
      output += `\n[bench: killed after ${timeoutMs}ms]`
      kill()
    }, timeoutMs)
    signal?.addEventListener('abort', kill, { once: true })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: 127, output: `${output}${error.message}` })
    })
    child.on('close', (code, sig) => {
      clearTimeout(timer)
      resolve({ code: code ?? (sig ? 128 + 9 : 1), output })
    })
  })
}

export async function runAcceptance(c: BenchCase, repo: string): Promise<{ name: string; ok: boolean; output: string }[]> {
  const out: { name: string; ok: boolean; output: string }[] = []
  for (const check of c.acceptance ?? []) {
    const res = await sh(check.cmd, repo, 60_000)
    out.push({ name: check.name, ok: res.code === 0, output: res.output.trim().slice(-2000) })
  }
  return out
}
