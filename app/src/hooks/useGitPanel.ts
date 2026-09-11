import { useCallback, useEffect, useState } from 'react'
import type { AiProvider, GitCommit, GitHubInfo, GitInfo, GitStatus } from '@shared/types'

const api = window.farol

function sameProject(a: string, b: string): boolean {
  return a.replace(/[/\\]+$/, '') === b.replace(/[/\\]+$/, '')
}

export type GitAction = 'commit' | 'push' | 'pr' | 'conflicts'

export type GitCommitDraft = {
  message: string
  files: string[]
  skipped: string[]
}

type UseGitPanelOptions = {
  /** Fetch status and GitHub info when true (e.g. tab visible and cwd is a repo). */
  enabled?: boolean
  open?: boolean
  /** Called when HEAD changes for this project; the hook also refreshes panel data. */
  onHeadChange?: (info: GitInfo) => void
  /** Hand a conflict-resolution prompt to Chat. */
  onAskAi?: (prompt: string) => void
}

export function useGitPanel(
  projectPath: string,
  ai: () => { agent: AiProvider; model?: string },
  opts?: UseGitPanelOptions
) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [github, setGithub] = useState<GitHubInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [gitAction, setGitAction] = useState<GitAction | null>(null)
  const [draft, setDraft] = useState<GitCommitDraft | null>(null)
  const [lastMessage, setLastMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const refresh = useCallback(() => setRefreshVersion((version) => version + 1), [])

  useEffect(() => {
    setStatus(null)
    setCommits([])
    setGithub(null)
    setDraft(null)
    setLastMessage(null)
    setError(null)
    setRefreshError(null)
  }, [projectPath])

  useEffect(() => {
    if (!opts?.enabled || !projectPath) return
    let cancelled = false
    const jobs = [
      {
        delay: opts.open ? 5000 : 30000,
        read: async () => {
          setLoading(true)
          const [st, log] = await Promise.all([
            api.git.status(projectPath),
            api.git.recentCommits(projectPath)
          ])
          return () => {
            setStatus(st)
            setCommits(log)
            setRefreshError(null)
          }
        },
        fail: (message: string) => setRefreshError(message),
        finish: () => setLoading(false)
      },
      {
        delay: 60000,
        read: async () => {
          const gh = await api.git.github(projectPath)
          return () => setGithub(gh)
        },
        fail: (message: string) => setGithub({ available: false, prs: [], message })
      }
    ]
    const cleanups = jobs.map(({ delay, read, fail, finish }) => {
      let timer: number
      let busy = false
      const update = async () => {
        if (busy || document.hidden) return
        window.clearTimeout(timer)
        busy = true
        try {
          const apply = await read()
          if (!cancelled) apply()
        } catch (err) {
          if (!cancelled) fail(err instanceof Error ? err.message : 'Could not update Git information')
        } finally {
          busy = false
          if (!cancelled) {
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
    })
    return () => {
      cancelled = true
      cleanups.forEach((cleanup) => cleanup())
      setLoading(false)
    }
  }, [opts?.enabled, opts?.open, projectPath, refreshVersion])

  useEffect(() => {
    return api.git.onChanged((changed) => {
      if (!sameProject(changed.projectPath, projectPath)) return
      opts?.onHeadChange?.(changed.info)
      refresh()
    })
  }, [opts?.onHeadChange, projectPath, refresh])

  const prepareCommit = useCallback(async () => {
    if (gitAction) return
    setGitAction('commit')
    setError(null)
    setLastMessage(null)
    try {
      const { agent, model } = ai()
      const res = await api.git.draftCommit(projectPath, agent, model)
      if (res.ok && res.message) {
        setDraft({
          message: res.message,
          files: res.files ?? [],
          skipped: res.skipped ?? []
        })
      } else {
        setError(res.error || 'Could not generate commit message')
      }
    } finally {
      setGitAction(null)
    }
  }, [ai, gitAction, projectPath])

  const confirmCommit = useCallback(async () => {
    if (!draft || gitAction) return
    setGitAction('commit')
    setError(null)
    setLastMessage(null)
    try {
      const res = await api.git.commit(projectPath, draft.message, draft.files)
      if (res.ok && res.message) {
        setDraft(null)
        setLastMessage(res.message)
        void refresh()
      } else {
        setError(res.error || 'Commit failed')
      }
    } finally {
      setGitAction(null)
    }
  }, [draft, gitAction, projectPath, refresh])

  /** Run a remote action that reports its outcome as a single message either way. */
  const runRemote = useCallback(
    async (
      kind: GitAction,
      op: () => Promise<{ ok: boolean; message: string; prompt?: string }>,
      failed: string
    ) => {
      if (gitAction) return
      setGitAction(kind)
      setError(null)
      setLastMessage(null)
      try {
        const res = await op()
        if (res.ok && res.message) {
          setLastMessage(res.message)
          void refresh()
          return res
        }
        setError(res.message || failed)
      } finally {
        setGitAction(null)
      }
    },
    [gitAction, refresh]
  )

  const push = useCallback(
    () => runRemote('push', () => api.git.push(projectPath), 'Push failed'),
    [projectPath, runRemote]
  )

  const createPr = useCallback(
    () => runRemote('pr', () => api.git.createPr(projectPath), 'Could not create the pull request'),
    [projectPath, runRemote]
  )

  const resolveConflicts = useCallback(async () => {
    const res = await runRemote(
      'conflicts',
      () => api.git.bringConflicts(projectPath),
      'Could not bring pull request conflicts into the working tree'
    )
    if (res?.prompt) opts?.onAskAi?.(res.prompt)
  }, [opts?.onAskAi, projectPath, runRemote])

  return {
    status,
    commits,
    github,
    loading,
    gitAction,
    draft,
    lastMessage,
    error,
    refreshError,
    refresh,
    prepareCommit,
    setDraftMessage: (message: string) => setDraft((d) => (d ? { ...d, message } : d)),
    cancelDraft: () => setDraft(null),
    confirmCommit,
    push,
    createPr,
    resolveConflicts
  }
}
