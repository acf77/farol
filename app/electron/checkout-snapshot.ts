import { execFile, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { SNAPSHOT_LIMIT_BYTES, snapshotPaths } from '../shared/remote'

function gitFiles(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) =>
        error ? reject(new Error('Remote pipelines need a Git checkout to snapshot.')) : resolve(stdout)
    )
  })
}

/** The primary checkout, which holds `.farol/` for every linked worktree. Plain git, so the CLI script stays free of Electron. */
function primaryCheckout(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd }, (error, stdout) => {
      const common = stdout.trim()
      resolve(!error && path.basename(common) === '.git' ? path.dirname(common) : cwd)
    })
  })
}

function runTar(cwd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', args, { cwd, env: { ...process.env, COPYFILE_DISABLE: '1' } })
    const chunks: Buffer[] = []
    let size = 0
    tar.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > SNAPSHOT_LIMIT_BYTES) tar.kill()
      else chunks.push(chunk)
    })
    tar.on('error', reject)
    tar.on('close', (code) =>
      size > SNAPSHOT_LIMIT_BYTES
        ? reject(new Error(`Checkout snapshot is larger than ${SNAPSHOT_LIMIT_BYTES / 1024 / 1024} MB.`))
        : code === 0
          ? resolve(Buffer.concat(chunks))
          : reject(new Error(`tar exited with code ${code}.`))
    )
    tar.stdin.on('error', () => undefined)
    tar.stdin.end(input ?? '')
  })
}

/** Where the repo's pipelines live — `.farol/` is often gitignored, and linked worktrees share the primary's file. */
const PIPELINES_FILE = '.farol/pipelines.json'

async function packFiles(cwd: string, files: string[], pipelinesRoot: string | null): Promise<Buffer> {
  const input = files.join('\0') + '\0'
  if (!pipelinesRoot) return runTar(cwd, ['-czf', '-', '--null', '-T', '-'], input)
  // bsdtar reads `-T` lists after every `-C`, so the extra file is appended to a
  // plain tar on disk (where `-C` is safe) and gzipped afterwards.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-snapshot-'))
  const archive = path.join(dir, 'checkout.tar')
  try {
    await runTar(cwd, ['-cf', archive, '--null', '-T', '-'], input)
    await runTar(cwd, ['-rf', archive, '-C', pipelinesRoot, PIPELINES_FILE])
    const gz = zlib.gzipSync(fs.readFileSync(archive))
    if (gz.length > SNAPSHOT_LIMIT_BYTES) {
      throw new Error(`Checkout snapshot is larger than ${SNAPSHOT_LIMIT_BYTES / 1024 / 1024} MB.`)
    }
    return gz
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Which files travel, and where `.farol/pipelines.json` comes from when this checkout lacks it. */
export interface SnapshotPlan {
  /** Paths relative to the checkout, pipelines file excluded when it comes from `pipelinesRoot`. */
  files: string[]
  /** The primary checkout holding `.farol/pipelines.json`, or null when it is among `files`. */
  pipelinesRoot: string | null
}

export async function snapshotPlan(cwd: string): Promise<SnapshotPlan> {
  const files = snapshotPaths(await gitFiles(cwd)).filter((file) => {
    try {
      const stat = fs.lstatSync(path.join(cwd, file))
      return stat.isFile() || stat.isSymbolicLink()
    } catch {
      return false
    }
  })
  // The service refuses a snapshot without the pipeline file, but git may leave it
  // out (ignored `.farol/`) and a linked worktree does not hold it at all.
  const root = await primaryCheckout(cwd)
  const stored = fs.existsSync(path.join(root, PIPELINES_FILE))
  const extra = stored && !(root === cwd && files.includes(PIPELINES_FILE))
  return { files: extra ? files.filter((file) => file !== PIPELINES_FILE) : files, pipelinesRoot: extra ? root : null }
}

/** Gzipped tar of `files` (plus the pipelines file when `pipelinesRoot` is set). */
export function packSnapshot(cwd: string, files: string[], pipelinesRoot: string | null): Promise<Buffer> {
  return packFiles(cwd, files, pipelinesRoot)
}

/** Gzipped tar of the checkout for remote runs and the run-service CLI. */
export async function checkoutSnapshot(cwd: string): Promise<{ archive: Buffer; count: number }> {
  const plan = await snapshotPlan(cwd)
  return {
    archive: await packFiles(cwd, plan.files, plan.pipelinesRoot),
    count: plan.files.length + (plan.pipelinesRoot ? 1 : 0)
  }
}
