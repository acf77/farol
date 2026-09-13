import { useCallback, useEffect, useRef, useState } from 'react'
import { committableFiles } from '@shared/git-status'
import type { AiProvider, GitCommit, GitHubInfo, GitInfo, GitStatus } from '@shared/types'

const api = window.farol

function sameProject(a: string, b: string): boolean {
  return a.replace(/[/\\]+$/, '') === b.replace(/[/\\]+$/, '')
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export type GitAction = 'generate' | 'commit' | 'push' | 'pr' | 'conflicts'

export type GitCommitDraft = {
  message: string
  skipped: string[]
}

export type GitLogEntry = {
  id: number
  time: string
  action: string
  message: string
  ok: boolean
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

const EMPTY_DRAFT: GitCommitDraft = { message: '', skipped: [] }

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
  const [draft, setDraft] = useState<GitCommitDraft>(EMPTY_DRAFT)
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [log, setLog] = useState<GitLogEntry[]>([])
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const knownFiles = useRef<Set<string> | null>(null)
  const refreshFailing = useRef(false)
  const logId = useRef(0)
  const refresh = useCallback(() => setRefreshVersion((version) => version + 1), [])
  const appendLog = useCallback((action: string, message: string, ok: boolean) => {
    const time = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
    logId.current += 1
    const entry = { id: logId.current, time, action, message, ok }
    setLog((entries) => [...entries, entry])
  }, [])

  useEffect(() => {
    setStatus(null)
    setCommits([])
    setGithub(null)
    setDraft(EMPTY_DRAFT)
    setSelectedFiles([])
    setLog([])
    setRefreshError(null)
    knownFiles.current = null
    refreshFailing.current = false
    logId.current = 0
  }, [projectPath])

  useEffect(() => {
    if (!opts?.enabled || !projectPath) return
    let cancelled = false
    const jobs = [
      {
        delay: opts.open ? 5000 : 30000,
        read: async () => {
          setLoading(true)
          const [st, recent] = await Promise.all([
            api.git.status(projectPath),
            api.git.recentCommits(projectPath)
          ])
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
        fail: (message: string) => {
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
  }, [appendLog, opts?.enabled, opts?.open, projectPath, refreshVersion])

  useEffect(() => {
    return api.git.onChanged((changed) => {
      if (!sameProject(changed.projectPath, projectPath)) return
      opts?.onHeadChange?.(changed.info)
      refresh()
    })
  }, [opts?.onHeadChange, projectPath, refresh])

  const prepareCommit = useCallback(async () => {
    if (gitAction || !selectedFiles.length) return
    const files = selectedFiles
    setGitAction('generate')
    try {
      const { agent, model } = ai()
      const res = await api.git.draftCommit(projectPath, agent, model, files)
      if (res.ok && res.message) {
        setDraft({ message: res.message, skipped: res.skipped ?? [] })
      } else {
        appendLog('Generate with AI', res.error || 'Could not generate commit message', false)
      }
    } catch (error) {
      appendLog('Generate with AI', errorMessage(error, 'Could not generate commit message'), false)
    } finally {
      setGitAction(null)
    }
  }, [ai, appendLog, gitAction, projectPath, selectedFiles])

  const confirmCommit = useCallback(async () => {
    if (!draft.message.trim() || !selectedFiles.length || gitAction) return
    setGitAction('commit')
    try {
      const res = await api.git.commit(projectPath, draft.message, selectedFiles)
      if (res.ok && res.message) {
        appendLog('Commit', res.message, true)
        setDraft(EMPTY_DRAFT)
        void refresh()
      } else {
        appendLog('Commit', res.error || 'Commit failed', false)
      }
    } catch (error) {
      appendLog('Commit', errorMessage(error, 'Commit failed'), false)
    } finally {
      setGitAction(null)
    }
  }, [appendLog, draft.message, gitAction, projectPath, refresh, selectedFiles])

  /** Run a remote action and append its outcome to the session transcript. */
  const runRemote = useCallback(
    async (
      kind: GitAction,
      action: string,
      op: () => Promise<{ ok: boolean; message: string; prompt?: string }>,
      failed: string
    ) => {
      if (gitAction) return
      setGitAction(kind)
      try {
        const res = await op()
        appendLog(action, res.message || failed, res.ok)
        if (res.ok) {
          void refresh()
          return res
        }
      } catch (error) {
        appendLog(action, errorMessage(error, failed), false)
      } finally {
        setGitAction(null)
      }
    },
    [appendLog, gitAction, refresh]
  )

  const push = useCallback(
    () => runRemote('push', 'Push', () => api.git.push(projectPath), 'Push failed'),
    [projectPath, runRemote]
  )

  const createPr = useCallback(
    (base?: string, title?: string) =>
      runRemote(
        'pr',
        'Create pull request',
        () => api.git.createPr(projectPath, base, title),
        'Could not create the pull request'
      ),
    [projectPath, runRemote]
  )

  const resolveConflicts = useCallback(async () => {
    const res = await runRemote(
      'conflicts',
      'Check conflicts',
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
    selectedFiles,
    log,
    refreshError,
    refresh,
    prepareCommit,
    setDraftMessage: (message: string) => setDraft((current) => ({ ...current, message })),
    setFileSelected: (file: string, selected: boolean) =>
      setSelectedFiles((files) => {
        if (!selected) return files.filter((path) => path !== file)
        return files.includes(file) ? files : [...files, file]
      }),
    selectAllFiles: (files: string[]) => setSelectedFiles(files),
    confirmCommit,
    push,
    createPr,
    resolveConflicts
  }
}
