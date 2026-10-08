import { spawn } from 'child_process'
import { quoteShellArg } from '../shared/graph'
import { SANDBOX_TIMEOUT_MS } from '../shared/remote'
import type { RemoteWorkspace } from '../electron/sandbox'

const WORKDIR = '/root/project'
/**
 * A checkpoint the operator built from trusted setup (dependencies installed), which every
 * sandbox boots from. Runs never write one: a checkpoint captured from a user's run would
 * carry whatever that run left in the profile, PATH or node_modules into everyone's runs.
 */
const CHECKPOINT = process.env.RAILWAY_CHECKPOINT

/** Lines the CLI itself prints on stderr, mixed in with the step's own stderr. */
const CLI_NOISE = /^(Warning: Railway sandboxes|warning: Config as Code|\s+→ Migrate|\s+Existing files keep).*\n?/gm

/** Run `railway sandbox <args>`, optionally feeding `input` on stdin; resolves with the exit code and stdout. */
function railway(
  args: string[],
  { input, onChunk, signal }: { input?: Buffer; onChunk?: (chunk: string) => void; signal: AbortSignal }
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('railway', ['sandbox', ...args], { signal, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    const collect = (text: string): void => {
      if (!text) return
      stdout += text
      onChunk?.(text)
    }
    child.stdout.on('data', (data: Buffer) => collect(data.toString()))
    child.stderr.on('data', (data: Buffer) => collect(data.toString().replace(CLI_NOISE, '')))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

/** Create a sandbox and return its id, or undefined when the CLI refuses. */
async function createSandbox(extra: string[], signal: AbortSignal): Promise<string | undefined> {
  const created = await railway(
    ['create', '--json', '--idle-timeout-minutes', String(Math.ceil(SANDBOX_TIMEOUT_MS / 60_000)), ...extra],
    { signal }
  )
  try {
    return created.code === 0 ? JSON.parse(created.stdout).id : undefined
  } catch {
    return undefined
  }
}

/**
 * Start a Railway sandbox (via the `railway` CLI, authenticated by RAILWAY_API_TOKEN),
 * unpack the gzipped tar `archive` into the work directory, and destroy it on close or
 * any failure. It boots from RAILWAY_CHECKPOINT when that is set and exists.
 */
export async function openRailwaySandbox(
  archive: Buffer,
  summary: string,
  signal: AbortSignal
): Promise<RemoteWorkspace> {
  const restored = CHECKPOINT ? await createSandbox(['--checkpoint', CHECKPOINT], signal) : undefined
  const id = restored ?? (await createSandbox([], signal))
  if (!id) throw new Error('Creating the Railway sandbox failed.')

  let closed: Promise<unknown> | undefined
  const close = async (): Promise<void> => {
    closed ??= railway(['destroy', id], { signal: AbortSignal.timeout(30_000) }).catch(() => undefined)
    await closed
  }
  const exec = (cmd: string, opts: Parameters<typeof railway>[1]) => railway(['exec', '--id', id, '--', cmd], opts)

  try {
    // A fresh sandbox can refuse commands for a few seconds while it boots.
    let ready = await exec('true', { signal })
    for (let attempt = 0; ready.code !== 0 && attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      ready = await exec('true', { signal })
    }
    if (ready.code !== 0) throw new Error('The Railway sandbox did not become ready.')
    // A checkpoint may hold sources from when it was built; drop them but keep node_modules.
    const unpack = await exec(
      `mkdir -p ${WORKDIR} && find ${WORKDIR} -name node_modules -prune -o -type f -exec rm -f {} + && tar -xz -C ${WORKDIR} && find ${WORKDIR} -name '._*' -type f -delete`,
      { input: archive, signal }
    )
    if (unpack.code !== 0) throw new Error('Unpacking the checkout failed.')
  } catch (error) {
    await close()
    throw error
  }
  return {
    summary,
    close,
    async exec(cmd, onChunk) {
      return (await exec(`cd ${WORKDIR} && bash -lc ${quoteShellArg(cmd)}`, { onChunk, signal })).code
    }
  }
}
