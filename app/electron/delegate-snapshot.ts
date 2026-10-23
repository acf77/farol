/**
 * Snapshots of a checkout taken around a subagent run, so its changes can be
 * shown on their own and undone without touching the developer's branch,
 * index or stash list.
 *
 * A snapshot is a git tree of the working copy — tracked and untracked files,
 * `.gitignore` respected — written through a throwaway index file. Starting
 * that index from a copy of the real one means `git add -A` only rehashes
 * files that changed.
 */

import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env },
      (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout))
    )
  })
}

/** The working copy of `cwd`'s checkout as a tree id, or undefined outside a git checkout. */
export async function captureTree(cwd: string): Promise<string | undefined> {
  let root: string
  let realIndex: string
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
    realIndex = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim())
  } catch {
    return undefined
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-snap-'))
  const index = path.join(dir, 'index')
  try {
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, index)
    const env = { GIT_INDEX_FILE: index }
    await git(root, ['add', '-A', '--', '.'], env)
    return (await git(root, ['write-tree'], env)).trim()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** `git diff --stat` between two snapshots; empty when nothing changed. */
export async function treeDiffStat(cwd: string, before: string, after: string): Promise<string> {
  if (before === after) return ''
  return (await git(cwd, ['diff', '--stat', '--no-color', before, after])).trimEnd()
}
