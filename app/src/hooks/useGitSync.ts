import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { errorMessage } from '@shared/jev'
import { trimSlashes } from '@shared/project-groups'
import { committableFiles } from '@shared/git-status'
import type { GitCommit, GitHookInfo, GitHubInfo, GitInfo, GitStatus } from '@shared/types'

const api = window.farol

function sameProject(a: string, b: string): boolean {
  return trimSlashes(a) === trimSlashes(b)
}

type PollJob = {
  delay: number
  read: () => Promise<() => void>
  fail: (message: string) => void
  finish?: () => void
}

/** Repeatedly run a job on a timer, and immediately on window focus / tab visibility. */
function runPoller(job: PollJob, isCancelled: () => boolean): () => void {
  const { delay, read, fail, finish } = job
  let timer: number
  let busy = false
  const update = async () => {
    if (busy || document.hidden) return
    window.clearTimeout(timer)
    busy = true
    try {
      const apply = await read()
      if (!isCancelled()) apply()
    } catch (err) {
      if (!isCancelled()) fail(errorMessage(err, 'Could not update Git information'))
    } finally {
      busy = false
      if (!isCancelled()) {
        finish?.()
        timer = window.setTimeout(() => void update(), delay)
      }
    }
  }
  const onVisible = () => void update()
  void update()
  window.addEventListener('focus', onVisible)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    window.clearTimeout(timer)
    window.removeEventListener('focus', onVisible)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

type GitPollingParams = {
  projectPath: string
  open?: boolean
  base?: string
  isCancelled: () => boolean
  knownFiles: MutableRefObject<Set<string> | null>
  refreshFailing: MutableRefObject<boolean>
  setLoading: (loading: boolean) => void
  setStatus: (status: GitStatus) => void
  setCommits: (commits: GitCommit[]) => void
  setSelectedFiles: Dispatch<SetStateAction<string[]>>
  setRefreshError: (message: string | null) => void
  setGithub: (github: GitHubInfo | null) => void
  setHooks: (hooks: GitHookInfo[]) => void
  appendLog: (action: string, message: string, ok: boolean) => void
}

/** Poll status/commits, GitHub, and hook info on their own cadences until stopped. */
function startGitPolling(params: GitPollingParams): () => void {
  const {
    projectPath,
    open,
    base,
    isCancelled,
    knownFiles,
    refreshFailing,
    setLoading,
    setStatus,
    setCommits,
    setSelectedFiles,
    setRefreshError,
    setGithub,
    setHooks,
    appendLog
  } = params
  const jobs: PollJob[] = [
    {
      delay: open ? 5000 : 30000,
      read: async () => {
        setLoading(true)
        const [st, recent] = await Promise.all([api.git.status(projectPath, base), api.git.recentCommits(projectPath)])
        return () => {
          const live = committableFiles(st).files
          const known = knownFiles.current
          setStatus(st)
          setCommits(recent)
          setSelectedFiles((selected) => {
            const checked = new Set(selected)
            return known ? live.filter((file) => checked.has(file) || !known.has(file)) : live
          })
          knownFiles.current = new Set(live)
          refreshFailing.current = false
          setRefreshError(null)
        }
      },
      fail: (message) => {
        setRefreshError(message)
        if (!refreshFailing.current) appendLog('Refresh', message, false)
        refreshFailing.current = true
      },
      finish: () => setLoading(false)
    },
    {
      delay: 60000,
      read: async () => {
        const gh = await api.git.github(projectPath)
        return () => setGithub(gh)
      },
      fail: (message) => setGithub({ available: false, prs: [], message })
    },
    {
      delay: 60000,
      read: async () => {
        const hooks = await api.git.hooks(projectPath)
        return () => setHooks(hooks)
      },
      fail: () => setHooks([])
    }
  ]
  const cleanups = jobs.map((job) => runPoller(job, isCancelled))
  return () => cleanups.forEach((cleanup) => cleanup())
}

export type GitSyncOptions = {
  /** Branch the conflict check compares against; the backend defaults to `staging`. */
  base?: string
  /** Fetch status and GitHub info when true (e.g. tab visible and cwd is a repo). */
  enabled?: boolean
  open?: boolean
  /** Called when HEAD changes for this project; the hook also refreshes panel data. */
  onHeadChange?: (info: GitInfo) => void
}

/** The panel's read side: polled git data, the file selection it reconciles, and refresh. */
export function useGitSync(
  projectPath: string,
  opts: GitSyncOptions | undefined,
  appendLog: (action: string, message: string, ok: boolean) => void
) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [github, setGithub] = useState<GitHubInfo | null>(null)
  const [hooks, setHooks] = useState<GitHookInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const knownFiles = useRef<Set<string> | null>(null)
  const refreshFailing = useRef(false)
  const refresh = useCallback(() => setRefreshVersion((version) => version + 1), [])

  useEffect(() => {
    setStatus(null)
    setCommits([])
    setGithub(null)
    setHooks(null)
    setSelectedFiles([])
    setRefreshError(null)
    knownFiles.current = null
    refreshFailing.current = false
  }, [projectPath])

  useEffect(() => {
    if (!opts?.enabled || !projectPath) return
    let cancelled = false
    const stop = startGitPolling({
      projectPath,
      open: opts.open,
      base: opts.base,
      isCancelled: () => cancelled,
      knownFiles,
      refreshFailing,
      setLoading,
      setStatus,
      setCommits,
      setSelectedFiles,
      setRefreshError,
      setGithub,
      setHooks,
      appendLog
    })
    return () => {
      cancelled = true
      stop()
      setLoading(false)
    }
  }, [appendLog, opts?.base, opts?.enabled, opts?.open, projectPath, refreshVersion])

  useEffect(() => {
    return api.git.onChanged((changed) => {
      if (!sameProject(changed.projectPath, projectPath)) return
      opts?.onHeadChange?.(changed.info)
      refresh()
    })
  }, [opts?.onHeadChange, projectPath, refresh])

  return { status, commits, github, hooks, loading, selectedFiles, setSelectedFiles, refreshError, refresh }
}
