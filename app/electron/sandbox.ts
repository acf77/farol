import { Sandbox } from '@vercel/sandbox'
import { REMOTE_WORKDIR, SANDBOX_TIMEOUT_MS } from '../shared/remote'

export interface SandboxCredentials {
  token: string
  teamId: string
  projectId: string
}

export interface RemoteWorkspace {
  /** What was uploaded, e.g. `12 files, 0.4 MB`. */
  summary: string
  /** Run a shell step; resolves with its exit code. Output arrives with `\n` line ends. */
  exec(cmd: string, onChunk: (chunk: string) => void): Promise<number>
  /** Stop the sandbox. Safe to call more than once. */
  close(): Promise<void>
}

export function createSandbox(credentials: SandboxCredentials, signal: AbortSignal): Promise<Sandbox> {
  return Sandbox.create({ ...credentials, timeout: SANDBOX_TIMEOUT_MS, persistent: false, signal })
}

/** Start a sandbox, unpack the gzipped tar `archive` into the work directory, and stop it on any failure. */
export async function openSandbox(
  credentials: SandboxCredentials,
  archive: Buffer,
  summary: string,
  signal: AbortSignal
): Promise<RemoteWorkspace> {
  const sandbox = await createSandbox(credentials, signal)
  let closed: Promise<unknown> | undefined
  const close = async (): Promise<void> => {
    closed ??= sandbox.stop().catch(() => undefined)
    await closed
  }
  try {
    const mkdir = await sandbox.runCommand({ cmd: 'mkdir', args: ['-p', REMOTE_WORKDIR], signal })
    if (mkdir.exitCode !== 0) throw new Error(`Creating the work directory failed: ${await mkdir.stderr()}`)
    await sandbox.writeFiles([{ path: '/tmp/farol-snapshot.tgz', content: archive }], { signal })
    const unpack = await sandbox.runCommand({
      cmd: 'tar',
      args: ['-xzf', '/tmp/farol-snapshot.tgz', '-C', REMOTE_WORKDIR],
      signal
    })
    if (unpack.exitCode !== 0) throw new Error(`Unpacking the checkout failed: ${await unpack.stderr()}`)
    await sandbox.runCommand({
      cmd: 'find',
      args: [REMOTE_WORKDIR, '-name', '._*', '-type', 'f', '-delete'],
      signal
    })
  } catch (error) {
    await close()
    throw error
  }
  return {
    summary,
    close,
    async exec(cmd, onChunk) {
      const command = await sandbox.runCommand({
        cmd: 'bash',
        args: ['-lc', cmd],
        cwd: REMOTE_WORKDIR,
        detached: true,
        signal
      })
      for await (const log of command.logs({ signal })) onChunk(log.data)
      return (await command.wait({ signal })).exitCode
    }
  }
}
