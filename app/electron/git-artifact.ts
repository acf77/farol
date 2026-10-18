import { execFile, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { StringDecoder } from 'string_decoder'

/** Create or truncate, and fail with ELOOP when the last part of the path is a symlink. */
const WRITE_NO_FOLLOW = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0)
/** Characters of output kept in memory. The file holds the rest. */
const PREVIEW_CHARS = 100_000
const STDERR_LIMIT = 4000

export interface GitResult {
  /** The start of the output, at most `PREVIEW_CHARS` characters. */
  preview: string
  /** The output was longer than `preview`. */
  truncated: boolean
}

function openNoFollow(file: string): number {
  return fs.openSync(file, WRITE_NO_FOLLOW, 0o644)
}

/**
 * Open the result file `rel` under the checkout, and write a `.gitignore` that hides its folder.
 * A symlinked folder or file would send the write outside the checkout, so both are refused.
 */
function openArtifact(cwd: string, rel: string): number {
  let dir = cwd
  for (const part of path.dirname(rel).split('/')) {
    dir = path.join(dir, part)
    fs.mkdirSync(dir, { recursive: true })
    if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${path.relative(cwd, dir)} must be a real folder, not a link`)
  }
  const ignore = openNoFollow(path.join(dir, '.gitignore'))
  try {
    fs.writeFileSync(ignore, '*\n')
  } finally {
    fs.closeSync(ignore)
  }
  return openNoFollow(path.join(cwd, rel))
}

/** Run git and return the names it prints, which `args` must separate with NUL. */
export function listGitFiles(cwd: string, args: string[], signal: AbortSignal): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, signal, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.split('\0').filter(Boolean))
    )
  })
}

/**
 * Run git with `args` and stream its output to `rel`, so a huge diff never sits in memory.
 * Rejects with `stderr` and `code` on a non-zero exit, and when `signal` aborts.
 */
export async function runGitToArtifact(cwd: string, args: string[], rel: string, signal: AbortSignal): Promise<GitResult> {
  const fd = openArtifact(cwd, rel)
  return new Promise((resolve, reject) => {
    const git = spawn('git', args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const decoder = new StringDecoder('utf8')
    let preview = ''
    let truncated = false
    let stderr = ''
    let closed = false
    const finish = (): void => {
      if (!closed) fs.closeSync(fd)
      closed = true
    }
    const keep = (text: string): void => {
      const room = PREVIEW_CHARS - preview.length
      preview += text.slice(0, room)
      truncated ||= text.length > room
    }
    git.stdout.on('data', (chunk: Buffer) => {
      if (closed) return
      try {
        fs.writeFileSync(fd, chunk)
      } catch (error) {
        git.kill()
        finish()
        reject(error)
        return
      }
      keep(decoder.write(chunk))
    })
    git.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT)
    })
    git.on('error', (error) => {
      finish()
      reject(error)
    })
    git.on('close', (code) => {
      finish()
      keep(decoder.end())
      if (code === 0) resolve({ preview, truncated })
      else reject(Object.assign(new Error(`git exited with code ${code}`), { stderr, code }))
    })
  })
}
