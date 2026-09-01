import { execFile } from 'child_process'
import { aiEnv, resolveBin } from './bin'

export function execCli(
  bin: string,
  cwd: string,
  args: string[],
  timeout: number
): Promise<{ code: number; out: string; err: string }> {
  const resolved = resolveBin(bin) ?? bin
  const env = aiEnv()
  return new Promise((resolve) => {
    execFile(
      resolved,
      args,
      { cwd, timeout, maxBuffer: 4 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((error as unknown as { code: number }).code as number)
            : error
              ? 1
              : 0
        resolve({ code, out: stdout.toString(), err: stderr.toString() })
      }
    )
  })
}
