import { useCallback, useEffect, useState } from 'react'
import type { AiProvider, GitCommit, GitHubInfo, GitInfo, GitStatus } from '@shared/types'

const api = window.farol

function sameProject(a: string, b: string): boolean {
  return a.replace(/[/\\]+$/, '') === b.replace(/[/\\]+$/, '')
}

export type GitCommitDraft = {
  message: string
  files: string[]
  skipped: string[]
}

type UseGitPanelOptions = {
  /** Fetch status and GitHub info when true (e.g. tab visible and cwd is a repo). */
  enabled?: boolean
  /** Called when HEAD changes for this project; the hook also refreshes panel data. */
  onHeadChange?: (info: GitInfo) => void
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
  const [gitAction, setGitAction] = useState<'commit' | 'push' | null>(null)
  const [draft, setDraft] = useState<GitCommitDraft | null>(null)
  const [lastMessage, setLastMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setStatus(null)
    setCommits([])
    setGithub(null)
    setDraft(null)
    setLastMessage(null)
    setError(null)
  }, [projectPath])

  const refresh = useCallback(async () => {
    if (!projectPath) return
    setLoading(true)
    try {
      const [st, gh, log] = await Promise.all([
        api.git.status(projectPath),
        api.git.github(projectPath),
        api.git.recentCommits(projectPath)
      ])
      setStatus(st)
      setGithub(gh)
      setCommits(log)
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  useEffect(() => {
    if (!opts?.enabled) return
    void refresh()
  }, [opts?.enabled, projectPath, refresh])

  useEffect(() => {
    if (!opts?.onHeadChange) return
    return api.git.onChanged((changed) => {
      if (!sameProject(changed.projectPath, projectPath)) return
      opts.onHeadChange!(changed.info)
      void refresh()
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

  const push = useCallback(async () => {
    if (gitAction) return
    setGitAction('push')
    setError(null)
    setLastMessage(null)
    try {
      const res = await api.git.push(projectPath)
      if (res.ok && res.message) {
        setLastMessage(res.message)
        void refresh()
      } else {
        setError(res.message || 'Push failed')
      }
    } finally {
      setGitAction(null)
    }
  }, [gitAction, projectPath, refresh])

  return {
    status,
    commits,
    github,
    loading,
    gitAction,
    draft,
    lastMessage,
    error,
    refresh,
    prepareCommit,
    setDraftMessage: (message: string) => setDraft((d) => (d ? { ...d, message } : d)),
    cancelDraft: () => setDraft(null),
    confirmCommit,
    push
  }
}
