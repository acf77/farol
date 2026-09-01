import { execFile } from 'child_process'

export function execCli(
  bin: string,
  cwd: string,
  args: string[],
  timeout: number
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd, timeout, maxBuffer: 4 * 1024 * 1024 },
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
