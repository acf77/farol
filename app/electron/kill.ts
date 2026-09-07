/**
 * Kill a process and, on Unix, its process group. AI CLIs and pipeline
 * shells spawn children; signalling only the parent leaves them running,
 * which is why Stop looked like a no-op.
 */
export function killPidTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      /* not a group leader, or already gone */
    }
  }
  try {
    process.kill(pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL')
  } catch {
    try {
      process.kill(pid)
    } catch {
      /* gone */
    }
  }
}

export function killPty(proc: { pid: number; kill: (signal?: string) => void } | null | undefined): void {
  if (!proc) return
  killPidTree(proc.pid)
  try {
    proc.kill(process.platform === 'win32' ? undefined : 'SIGKILL')
  } catch {
    /* already gone */
  }
}
