import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage } from '@shared/jev'
import { trimSlashes } from '@shared/project-groups'
import { activeHooks, gitHookFailurePrompt } from '@shared/git-status'
import type { AiProvider, GitHookRun, GitHubInfo, MergeStrategy, PrDraft } from '@shared/types'
import { useGitSync, type GitSyncOptions } from './useGitSync'

const api = window.farol

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

type UseGitPanelOptions = GitSyncOptions & {
  /** Hand a conflict-resolution prompt to Chat. */
  onAskAi?: (prompt: string) => void
}

const EMPTY_DRAFT: GitCommitDraft = { message: '', skipped: [] }
const EMPTY_PR_DRAFT: PrDraft = { title: '', description: '' }

type RemoteResult = {
  ok: boolean
  message: string
  prompt?: string
  hookRun?: GitHookRun
  github?: GitHubInfo
}

type RunRemote = (
  kind: GitAction,
  action: string,
  op: () => Promise<RemoteResult>,
  failed: string
) => Promise<RemoteResult | undefined>

export function useGitPanel(
  projectPath: string,
  ai: () => { agent: AiProvider; model?: string },
  opts?: UseGitPanelOptions
) {
  const [gitAction, setGitAction] = useState<GitAction | null>(null)
  const [draft, setDraft] = useState<GitCommitDraft>(EMPTY_DRAFT)
  const [prDraft, setPrDraft] = useState<PrDraft>(EMPTY_PR_DRAFT)
  const [log, setLog] = useState<GitLogEntry[]>([])
  const logId = useRef(0)
  // Callers pass `opts` inline; read `onAskAi` through a ref so it never destabilises the actions.
  const onAskAiRef = useRef(opts?.onAskAi)
  onAskAiRef.current = opts?.onAskAi
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
  const [conflictBase, setConflictBase] = useState<string>()
  const sync = useGitSync(projectPath, { ...opts, base: conflictBase }, appendLog)
  const { hooks, selectedFiles, setSelectedFiles, refresh, applyGithubPollResult, burstGithubPoll, githubBranchRef, githubGenRef, githubPollGenRef } =
    sync
  const projectRef = useRef(projectPath)
  projectRef.current = projectPath

  useEffect(() => {
    setDraft(EMPTY_DRAFT)
    setPrDraft(EMPTY_PR_DRAFT)
    setConflictBase(undefined)
    setLog([])
    logId.current = 0
  }, [projectPath])

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

  /** Log a hook that blocked a commit/push and hand its output to Chat to fix. */
  const reportHookRun = useCallback(
    (kind: 'commit' | 'push', hookRun: GitHookRun) => {
      appendLog('Hooks', `${hookRun.hooks.join(', ')} blocked the ${kind}:\n${hookRun.output}`, false)
      onAskAiRef.current?.(gitHookFailurePrompt(kind, hookRun.hooks, hookRun.output))
    },
    [appendLog]
  )

  /** Note in the log which hooks are about to run, before the underlying git command starts. */
  const announceHooks = useCallback(
    (kind: 'commit' | 'push') => {
      const running = activeHooks(hooks ?? [], kind)
      if (running.length) appendLog('Hooks', `Running ${running.map((hook) => hook.name).join(', ')}…`, true)
    },
    [appendLog, hooks]
  )

  const confirmCommit = useCallback(async () => {
    if (!draft.message.trim() || !selectedFiles.length || gitAction) return
    setGitAction('commit')
    announceHooks('commit')
    try {
      const res = await api.git.commit(projectPath, draft.message, selectedFiles)
      if (res.ok && res.message) {
        appendLog('Commit', res.message, true)
        setDraft(EMPTY_DRAFT)
        void refresh()
      } else {
        appendLog('Commit', res.error || 'Commit failed', false)
        if (res.hookRun) reportHookRun('commit', res.hookRun)
      }
    } catch (error) {
      appendLog('Commit', errorMessage(error, 'Commit failed'), false)
    } finally {
      setGitAction(null)
    }
  }, [announceHooks, appendLog, draft.message, gitAction, projectPath, refresh, reportHookRun, selectedFiles])

  /** Run a remote action and append its outcome to the session transcript. */
  const runRemote = useCallback<RunRemote>(
    async (kind, action, op, failed) => {
      if (gitAction) return
      setGitAction(kind)
      if (kind === 'push') announceHooks('push')
      try {
        const res = await op()
        appendLog(action, res.message || failed, res.ok)
        if (!res.ok && res.hookRun) reportHookRun('push', res.hookRun)
        void refresh()
        return res
      } catch (error) {
        appendLog(action, errorMessage(error, failed), false)
      } finally {
        setGitAction(null)
      }
    },
    [announceHooks, appendLog, gitAction, refresh, reportHookRun]
  )

  // Stable identities matter: App's git-control effect depends on `pull`, and a fresh
  // function every render re-sets App state, which re-renders this hook — an endless loop.
  const remotes = useMemo(
    () => ({
      push: () => runRemote('push', 'Push', () => api.git.push(projectPath), 'Push failed'),
      pull: () => runRemote('pull', 'Pull', () => api.git.pull(projectPath), 'Pull failed'),
      createPr: (base?: string, title?: string, body?: string) =>
        runRemote(
          'pr',
          'Create pull request',
          async () => {
            const cwd = projectPath
            const ctx = {
              project: cwd,
              branch: githubBranchRef.current,
              gen: githubGenRef.current,
              poll: githubPollGenRef.current
            }
            const res = await api.git.createPr(cwd, base, title, body)
            const live =
              trimSlashes(projectRef.current) === trimSlashes(ctx.project) &&
              githubBranchRef.current === ctx.branch &&
              githubGenRef.current === ctx.gen &&
              githubPollGenRef.current === ctx.poll
            if (res.ok && live) {
              if (res.github) applyGithubPollResult(res.github)
              burstGithubPoll()
            }
            return res
          },
          'Could not create the pull request'
        ),
      mergePr: (strategy: MergeStrategy) =>
        runRemote(
          'merge',
          'Merge pull request',
          () => api.git.mergePr(projectPath, strategy),
          'Could not merge the pull request'
        )
    }),
    [applyGithubPollResult, burstGithubPoll, githubBranchRef, githubGenRef, githubPollGenRef, projectPath, runRemote]
  )

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
      'Fix conflicts with AI',
      () => api.git.bringConflicts(projectPath, conflictBase),
      'Could not bring pull request conflicts into the working tree'
    )
    if (res?.prompt) onAskAiRef.current?.(res.prompt)
  }, [conflictBase, projectPath, runRemote])

  return {
    ...sync,
    gitAction,
    draft,
    prDraft,
    log,
    setConflictBase,
    prepareCommit,
    preparePr,
    setDraftMessage: (message: string) => setDraft((current) => ({ ...current, message })),
    setPrTitle: (title: string) => setPrDraft((current) => ({ ...current, title })),
    setPrDescription: (description: string) =>
      setPrDraft((current) => ({ ...current, description })),
    setFileSelected: (file: string, selected: boolean) =>
      setSelectedFiles((files) => {
        if (!selected) return files.filter((path) => path !== file)
        return files.includes(file) ? files : [...files, file]
      }),
    selectAllFiles: setSelectedFiles,
    confirmCommit,
    ...remotes,
    resolveConflicts
  }
}
