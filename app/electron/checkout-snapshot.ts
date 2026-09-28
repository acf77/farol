import { execFile, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
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

function packFiles(cwd: string, files: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-czf', '-', '--null', '-T', '-'], {
      cwd,
      env: { ...process.env, COPYFILE_DISABLE: '1' }
    })
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
    tar.stdin.end(files.join('\0') + '\0')
  })
}

/** Gzipped tar of the checkout for remote runs and the run-service CLI. */
export async function checkoutSnapshot(cwd: string): Promise<{ archive: Buffer; count: number }> {
  const files = snapshotPaths(await gitFiles(cwd)).filter((file) => {
    try {
      const stat = fs.lstatSync(path.join(cwd, file))
      return stat.isFile() || stat.isSymbolicLink()
    } catch {
      return false
    }
  })
  return { archive: await packFiles(cwd, files), count: files.length }
}
