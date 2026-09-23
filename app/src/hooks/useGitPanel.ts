import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import { committableFiles } from '@shared/git-status'
import type {
  AiProvider,
  GitCommit,
  GitHubInfo,
  GitInfo,
  GitStatus,
  MergeStrategy,
  PrDraft
} from '@shared/types'

const api = window.farol

function sameProject(a: string, b: string): boolean {
  return a.replace(/[/\\]+$/, '') === b.replace(/[/\\]+$/, '')
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export type GitAction =
  | 'generate'
  | 'commit'
  | 'push'
  | 'pull'
  | 'pr'
  | 'generatePr'
  | 'merge'
  | 'conflicts'

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
const EMPTY_PR_DRAFT: PrDraft = { title: '', description: '' }

type PanelSetters = {
  setDraft: Dispatch<SetStateAction<GitCommitDraft>>
  setPrDraft: Dispatch<SetStateAction<PrDraft>>
  setSelectedFiles: Dispatch<SetStateAction<string[]>>
}

function createPanelUpdaters({ setDraft, setPrDraft, setSelectedFiles }: PanelSetters) {
  return {
    setDraftMessage: (message: string) => setDraft((current) => ({ ...current, message })),
    setPrTitle: (title: string) => setPrDraft((current) => ({ ...current, title })),
    setPrDescription: (description: string) =>
      setPrDraft((current) => ({ ...current, description })),
    setFileSelected: (file: string, selected: boolean) =>
      setSelectedFiles((files) => {
        if (!selected) return files.filter((path) => path !== file)
        return files.includes(file) ? files : [...files, file]
      }),
    selectAllFiles: (files: string[]) => setSelectedFiles(files)
  }
}

type RemoteResult = { ok: boolean; message: string; prompt?: string }

type RunRemote = (
  kind: GitAction,
  action: string,
  op: () => Promise<RemoteResult>,
  failed: string
) => Promise<RemoteResult | undefined>

function createRemoteActions(projectPath: string, runRemote: RunRemote) {
  return {
    push: () => runRemote('push', 'Push', () => api.git.push(projectPath), 'Push failed'),
    pull: () => runRemote('pull', 'Pull', () => api.git.pull(projectPath), 'Pull failed'),
    createPr: (base?: string, title?: string, body?: string) =>
      runRemote(
        'pr',
        'Create pull request',
        () => api.git.createPr(projectPath, base, title, body),
        'Could not create the pull request'
      ),
    mergePr: (strategy: MergeStrategy) =>
      runRemote(
        'merge',
        'Merge pull request',
        () => api.git.mergePr(projectPath, strategy),
        'Could not merge the pull request'
      )
  }
}

type RefreshJob = {
  delay: number
  read: () => Promise<() => void>
  fail: (message: string) => void
  finish?: () => void
}

function startRefreshJobs(jobs: RefreshJob[]): () => void {
  let cancelled = false
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
  }
}

function buildRefreshJobs(args: {
  projectPath: string
  open?: boolean
  knownFiles: MutableRefObject<Set<string> | null>
  refreshFailing: MutableRefObject<boolean>
  appendLog: (action: string, message: string, ok: boolean) => void
  setStatus: Dispatch<SetStateAction<GitStatus | null>>
  setCommits: Dispatch<SetStateAction<GitCommit[]>>
  setSelectedFiles: Dispatch<SetStateAction<string[]>>
  setRefreshError: Dispatch<SetStateAction<string | null>>
  setLoading: Dispatch<SetStateAction<boolean>>
  setGithub: Dispatch<SetStateAction<GitHubInfo | null>>
}): RefreshJob[] {
  const {
    projectPath,
    open,
    knownFiles,
    refreshFailing,
    appendLog,
    setStatus,
    setCommits,
    setSelectedFiles,
    setRefreshError,
    setLoading,
    setGithub
  } = args
  return [
    {
      delay: open ? 5000 : 30000,
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
  const [draft, setDraft] = useState<GitCommitDraft>(EMPTY_DRAFT)
  const [prDraft, setPrDraft] = useState<PrDraft>(EMPTY_PR_DRAFT)
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
    setLog((entries) => [
      ...entries,
      { id: logId.current, time, action, message, ok }
    ])
  }, [])

  useEffect(() => {
    setStatus(null)
    setCommits([])
    setGithub(null)
    setDraft(EMPTY_DRAFT)
    setPrDraft(EMPTY_PR_DRAFT)
    setSelectedFiles([])
    setLog([])
    setRefreshError(null)
    knownFiles.current = null
    refreshFailing.current = false
    logId.current = 0
  }, [projectPath])

  useEffect(() => {
    if (!opts?.enabled || !projectPath) return
    const stop = startRefreshJobs(
      buildRefreshJobs({
        projectPath,
        open: opts.open,
        knownFiles,
        refreshFailing,
        appendLog,
        setStatus,
        setCommits,
        setSelectedFiles,
        setRefreshError,
        setLoading,
        setGithub
      })
    )
    return () => {
      stop()
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

  const prepareCommit = useCallback(async (provider?: AiProvider, model?: string) => {
    if (gitAction || !selectedFiles.length) return
    const files = selectedFiles
    setGitAction('generate')
    try {
      const selection = provider ? { agent: provider, model } : ai()
      const res = await api.git.draftCommit(projectPath, selection.agent, selection.model, files)
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

  const runRemote = useCallback<RunRemote>(
    async (kind, action, op, failed) => {
      if (gitAction) return
      setGitAction(kind)
      try {
        const res = await op()
        appendLog(action, res.message || failed, res.ok)
        void refresh()
        return res
      } catch (error) {
        appendLog(action, errorMessage(error, failed), false)
      } finally {
        setGitAction(null)
      }
    },
    [appendLog, gitAction, refresh]
  )

  const remotes = createRemoteActions(projectPath, runRemote)

  const preparePr = useCallback(
    async (base: string, provider?: AiProvider, model?: string) => {
      if (gitAction || !base.trim()) return
      setGitAction('generatePr')
      try {
        const selection = provider ? { agent: provider, model } : ai()
        const res = await api.git.draftPr(projectPath, selection.agent, selection.model, base)
        if (res.ok && res.title) {
          setPrDraft({ title: res.title, description: res.description ?? '' })
        } else {
          appendLog('Generate pull request', res.error || 'Could not generate pull request', false)
        }
      } catch (error) {
        appendLog(
          'Generate pull request',
          errorMessage(error, 'Could not generate pull request'),
          false
        )
      } finally {
        setGitAction(null)
      }
    },
    [ai, appendLog, gitAction, projectPath]
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
    prDraft,
    selectedFiles,
    log,
    refreshError,
    refresh,
    prepareCommit,
    preparePr,
    ...createPanelUpdaters({ setDraft, setPrDraft, setSelectedFiles }),
    confirmCommit,
    ...remotes,
    resolveConflicts
  }
}
