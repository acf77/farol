import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { errorMessage } from '@shared/jev'
import { trimSlashes } from '@shared/project-groups'
import { committableFiles } from '@shared/git-status'
import type { GitCommit, GitHookInfo, GitHubInfo, GitInfo, GitStatus } from '@shared/types'

const api = window.farol
const GITHUB_POLL_OPEN_MS = 20_000
const GITHUB_POLL_IDLE_MS = 60_000
const GITHUB_BURST_MS = 3_000
const GITHUB_BURST_COUNT = 5

function sameProject(a: string, b: string): boolean {
  return trimSlashes(a) === trimSlashes(b)
}

function mergeGithubPoll(prev: GitHubInfo | null, gh: GitHubInfo, clearPrevious: boolean): GitHubInfo {
  if (gh.available) return gh
  return {
    available: false,
    message: gh.message || 'GitHub is unavailable.',
    prs: clearPrevious && prev?.prs.length ? [] : (gh.prs ?? [])
  }
}

type GithubFetchCtx = { seq: number; poll: number; branch: string | undefined }

function beginGithubFetch(
  seq: MutableRefObject<number>,
  pollGen: MutableRefObject<number>,
  githubBranch: MutableRefObject<string | undefined>
): GithubFetchCtx {
  seq.current += 1
  return { seq: seq.current, poll: pollGen.current, branch: githubBranch.current }
}

function applyGithubFetch(
  ctx: GithubFetchCtx,
  applied: MutableRefObject<number>,
  pollGen: MutableRefObject<number>,
  githubBranch: MutableRefObject<string | undefined>,
  apply: () => void
): void {
  if (ctx.seq < applied.current) return
  if (ctx.poll !== pollGen.current) return
  if (ctx.branch !== undefined && ctx.branch !== githubBranch.current) return
  applied.current = ctx.seq
  apply()
}

type PollJob = {
  delay: number | (() => number)
  read: () => Promise<() => void>
  fail: (message: string) => void
  finish?: () => void
}

/** Repeatedly run a job on a timer, and immediately on window focus / tab visibility. */
function runPoller(job: PollJob, isCancelled: () => boolean): () => void {
  const { read, fail, finish } = job
  const delayMs = (): number => (typeof job.delay === 'function' ? job.delay() : job.delay)
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
        timer = window.setTimeout(() => void update(), delayMs())
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
  setGithub: Dispatch<SetStateAction<GitHubInfo | null>>
  setHooks: (hooks: GitHookInfo[]) => void
  appendLog: (action: string, message: string, ok: boolean) => void
  pollGen: MutableRefObject<number>
  githubBranch: MutableRefObject<string | undefined>
  githubSeq: MutableRefObject<number>
  githubApplied: MutableRefObject<number>
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
    appendLog,
    pollGen,
    githubBranch,
    githubSeq,
    githubApplied
  } = params
  let githubPollMs = GITHUB_POLL_IDLE_MS
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
      delay: () => githubPollMs,
      read: async () => {
        const ctx = beginGithubFetch(githubSeq, pollGen, githubBranch)
        try {
          const gh = await api.git.github(projectPath)
          return () => {
            applyGithubFetch(ctx, githubApplied, pollGen, githubBranch, () => {
              const clearPrevious = githubBranch.current !== undefined
              setGithub((prev) => mergeGithubPoll(prev, gh, clearPrevious))
              githubPollMs = gh.prs.length > 0 ? GITHUB_POLL_OPEN_MS : GITHUB_POLL_IDLE_MS
            })
          }
        } catch (err) {
          const message = errorMessage(err, 'Could not update Git information')
          return () => {
            applyGithubFetch(ctx, githubApplied, pollGen, githubBranch, () => {
              setGithub({ available: false, prs: [], message })
            })
          }
        }
      },
      fail: () => {
        /* github errors return an apply closure from read */
      }
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
  const projectRef = useRef(projectPath)
  projectRef.current = projectPath
  const githubGen = useRef(0)
  const pollGen = useRef(0)
  const githubSeq = useRef(0)
  const githubApplied = useRef(0)
  const githubBranch = useRef<string | undefined>(undefined)
  const burstGen = useRef(0)
  const burstTimer = useRef<number | undefined>(undefined)
  const refresh = useCallback(() => setRefreshVersion((version) => version + 1), [])

  const stopBurstPoll = useCallback(() => {
    burstGen.current += 1
    if (burstTimer.current !== undefined) {
      window.clearTimeout(burstTimer.current)
      burstTimer.current = undefined
    }
  }, [])

  const burstGithubPoll = useCallback(() => {
    if (!projectPath) return
    stopBurstPoll()
    const path = projectPath
    const gen = burstGen.current
    let count = 0
    const tick = async (): Promise<void> => {
      if (gen !== burstGen.current || projectRef.current !== path) {
        return
      }
      count += 1
      try {
        const ctx = beginGithubFetch(githubSeq, pollGen, githubBranch)
        const gh = await api.git.github(path)
        if (gen !== burstGen.current || projectRef.current !== path) return
        applyGithubFetch(ctx, githubApplied, pollGen, githubBranch, () => {
          const clearPrevious = githubBranch.current !== undefined
          setGithub((prev) => mergeGithubPoll(prev, gh, clearPrevious))
        })
      } catch {
        /* regular poll will surface errors */
      }
      if (gen !== burstGen.current || count >= GITHUB_BURST_COUNT || projectRef.current !== path) {
        return
      }
      burstTimer.current = window.setTimeout(() => void tick(), GITHUB_BURST_MS)
    }
    void tick()
  }, [projectPath, stopBurstPoll])

  useEffect(() => {
    githubGen.current += 1
    pollGen.current += 1
    githubBranch.current = undefined
    stopBurstPoll()
    setStatus(null)
    setCommits([])
    setGithub(null)
    setHooks(null)
    setSelectedFiles([])
    setRefreshError(null)
    knownFiles.current = null
    refreshFailing.current = false
  }, [projectPath, stopBurstPoll])

  useEffect(() => {
    if (!opts?.enabled || !projectPath) {
      stopBurstPoll()
      return
    }
    const path = projectPath
    const initPoll = pollGen.current
    let cancelled = false
    let stopPolling: (() => void) | undefined
    void (async () => {
      try {
        const info = await api.git.info(path)
        if (cancelled || initPoll !== pollGen.current) return
        if (sameProject(projectRef.current, path) && githubBranch.current === undefined) {
          githubBranch.current = info.branch
        }
      } catch {
        /* branch stays undefined until HEAD watcher or a later refresh */
      }
      if (cancelled || initPoll !== pollGen.current) return
      stopPolling = startGitPolling({
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
        appendLog,
        pollGen,
        githubBranch,
        githubSeq,
        githubApplied
      })
    })()
    return () => {
      cancelled = true
      pollGen.current += 1
      stopPolling?.()
      setLoading(false)
    }
  }, [appendLog, opts?.base, opts?.enabled, opts?.open, projectPath, refreshVersion])

  useEffect(() => {
    return () => stopBurstPoll()
  }, [opts?.enabled, projectPath, stopBurstPoll])

  useEffect(() => {
    return api.git.onChanged((changed) => {
      if (!sameProject(changed.projectPath, projectPath)) return
      const branch = changed.info.branch
      if (githubBranch.current !== branch) {
        pollGen.current += 1
        githubGen.current += 1
        stopBurstPoll()
        setGithub(null)
      }
      githubBranch.current = branch
      opts?.onHeadChange?.(changed.info)
      refresh()
    })
  }, [opts?.onHeadChange, projectPath, refresh, stopBurstPoll])

  return {
    status,
    commits,
    github,
    setGithub,
    burstGithubPoll,
    githubBranchRef: githubBranch,
    githubGenRef: githubGen,
    hooks,
    loading,
    selectedFiles,
    setSelectedFiles,
    refreshError,
    refresh
  }
}
