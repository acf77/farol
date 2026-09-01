import { useCallback, useEffect, useState } from 'react'
import type { AiProvider, GitHubInfo, GitInfo, GitStatus } from '@shared/types'

const api = window.farol

function sameProject(a: string, b: string): boolean {
  return a.replace(/[/\\]+$/, '') === b.replace(/[/\\]+$/, '')
}

type UseGitPanelOptions = {
  /** Fetch status and GitHub info when true (e.g. tab visible and cwd is a repo). */
  enabled?: boolean
  /** Called when HEAD changes for this project; the hook also refreshes panel data. */
  onHeadChange?: (info: GitInfo) => void
}

export function useGitPanel(
  projectPath: string,
  provider: () => AiProvider,
  opts?: UseGitPanelOptions
) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [github, setGithub] = useState<GitHubInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [lastMessage, setLastMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setStatus(null)
    setGithub(null)
    setLastMessage(null)
    setError(null)
  }, [projectPath])

  const refresh = useCallback(async () => {
    if (!projectPath) return
    setLoading(true)
    try {
      const [st, gh] = await Promise.all([
        api.git.status(projectPath),
        api.git.github(projectPath)
      ])
      setStatus(st)
      setGithub(gh)
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

  const aiCommit = useCallback(async () => {
    if (committing) return
    setCommitting(true)
    setError(null)
    setLastMessage(null)
    try {
      const res = await api.git.aiCommit(projectPath, provider())
      if (res.ok && res.message) {
        setLastMessage(res.message)
        void refresh()
      } else {
        setError(res.error || 'Commit failed')
      }
    } finally {
      setCommitting(false)
    }
  }, [committing, projectPath, provider, refresh])

  return {
    status,
    github,
    loading,
    committing,
    lastMessage,
    error,
    refresh,
    aiCommit
  }
}
