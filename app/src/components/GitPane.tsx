import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { aiSelectionLabel, normalizeModel } from '@shared/ai'
import {
  activeHooks,
  committableChanges,
  commitBlockReason,
  conflictMergeBase,
  conflictSignals,
  conflictStatusItems,
  mergePullRequestBlockReason,
  pullRequestBlockReason,
  pushBlockReason
} from '@shared/git-status'
import {
  MERGE_STRATEGIES,
  type AiProvider,
  type AppSettings,
  type GitFileKind,
  type GitHookInfo,
  type GitHubInfo,
  type GitStatus,
  type MergeStrategy,
  type PrCheck,
  type PrCheckState,
  type PrCheckSummary,
  type PrDraft
} from '@shared/types'
import { useGitPanel, type GitAction, type GitLogEntry } from '../hooks/useGitPanel'
import { C, MONO, UI, ELLIPSIS } from '../theme'
import { Button, Checkbox, CliModelDropdown } from './controls'
import { CheckIcon, RefreshIcon, Spinner } from './icons'

interface Props extends ReturnType<typeof useGitPanel> {
  branch: string
  branches: string[]
  remotes: string[]
  provider: AiProvider
  model?: string
  settings: AppSettings
  onCommitMessageModelChange: (provider: AiProvider, model: string | undefined) => void
  open: boolean
  onClose: () => void
  anchorRef: RefObject<HTMLElement | null>
}

export function gitStatusDotColor(status: GitStatus | null, github: GitHubInfo | null): string {
  if (conflictSignals(status, github).any) return C.red
  if (!status) return C.textMuted
  return status.clean ? C.green : C.yellow
}

const card: CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: 12,
  background: C.sidebar,
  padding: 16,
  minWidth: 0
}

const sectionLabel: CSSProperties = {
  color: C.textMuted,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase'
}

const input: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  background: C.terminal,
  color: C.textSoft,
  fontSize: 12,
  padding: '0 10px'
}

const KIND: Record<GitFileKind, { letter: string; color: string }> = {
  modified: { letter: 'M', color: C.yellow },
  added: { letter: 'A', color: C.green },
  deleted: { letter: 'D', color: C.red },
  renamed: { letter: 'R', color: C.purpleSoft },
  untracked: { letter: 'U', color: C.accent },
  conflict: { letter: '!', color: C.red }
}

function useEscapeClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
}

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'

function useFocusTrap(open: boolean, dialogRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = (): HTMLElement[] => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0]
      const last = items.at(-1)
      if (!first || !last) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const inside = dialog.contains(document.activeElement)
      if ((!event.shiftKey && (!inside || document.activeElement === last)) || (event.shiftKey && (!inside || document.activeElement === first))) {
        event.preventDefault()
        const target = event.shiftKey ? last : first
        target.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialogRef, open])
}

const HOLD_MS = 2500

/** Remote-reaching action: only fires after a 2.5 second press. */
function HoldButton({
  label,
  busyLabel,
  busy,
  disabled,
  title,
  onConfirm,
  style
}: {
  label: string
  busyLabel: string
  busy: boolean
  disabled: boolean
  title: string
  onConfirm: () => void
  style?: CSSProperties
}) {
  const [holding, setHolding] = useState(false)
  const timer = useRef<number | null>(null)
  const unbind = useRef<(() => void) | null>(null)

  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    unbind.current?.()
    unbind.current = null
    setHolding(false)
  }, [])

  useEffect(() => {
    if (disabled || busy) cancel()
  }, [busy, cancel, disabled])

  useEffect(() => () => cancel(), [cancel])

  const begin = (): void => {
    if (disabled || busy || timer.current !== null) return
    setHolding(true)
    const stop = (): void => cancel()
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    unbind.current = () => {
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    timer.current = window.setTimeout(() => {
      timer.current = null
      unbind.current?.()
      unbind.current = null
      setHolding(false)
      onConfirm()
    }, HOLD_MS)
  }

  return (
    <Button
      variant="secondary"
      size="md"
      disabled={disabled || busy}
      title={holding ? 'Keep holding to confirm' : title}
      aria-label={`${label}. Hold until the button fills to confirm`}
      aria-disabled={disabled || busy}
      className={`bf-hold-btn${holding ? ' is-holding' : ''}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.focus()
        begin()
      }}
      onKeyDown={(event) => {
        if ((event.key !== ' ' && event.key !== 'Enter') || event.repeat) return
        event.preventDefault()
        begin()
      }}
      onKeyUp={(event) => {
        if (event.key !== ' ' && event.key !== 'Enter') return
        event.preventDefault()
        cancel()
      }}
      onBlur={cancel}
      onContextMenu={(event) => event.preventDefault()}
      style={{
        flex: 1,
        color: holding ? C.accentInk : undefined,
        opacity: disabled && !busy ? 0.45 : undefined,
        cursor: disabled && !busy ? 'not-allowed' : undefined,
        ['--bf-hold-ms' as string]: `${HOLD_MS}ms`,
        ...style
      }}
    >
      <span className="bf-hold-fill" aria-hidden />
      <span className="bf-hold-label">
        {busy ? <><Spinner /> {busyLabel}</> : label}
      </span>
    </Button>
  )
}

/** A remote action that asks for a second click before it runs. */
function ConfirmButton({
  label,
  confirmLabel,
  busyLabel,
  busy,
  disabled,
  title,
  onConfirm
}: {
  label: string
  confirmLabel: string
  busyLabel: string
  busy: boolean
  disabled: boolean
  title: string
  onConfirm: () => void
}) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (disabled) {
      setArmed(false)
      return
    }
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 6000)
    return () => window.clearTimeout(timer)
  }, [armed, disabled])

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled || busy}
      onBlur={() => setArmed(false)}
      title={armed ? 'Click again to confirm' : title}
      onClick={() => {
        if (!armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        onConfirm()
      }}
    >
      {busy ? <><Spinner /> {busyLabel}</> : armed ? confirmLabel : label}
    </Button>
  )
}

function ChangesCard({
  status,
  selectedFiles,
  onSelected,
  onSelectAll
}: {
  status: GitStatus | null
  selectedFiles: string[]
  onSelected: (file: string, selected: boolean) => void
  onSelectAll: (files: string[]) => void
}) {
  const files = status ? committableChanges(status) : []
  const selected = new Set(selectedFiles)
  const allSelected = files.length > 0 && files.every((file) => selected.has(file.path))

  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={sectionLabel}>Changes · {files.length} {files.length === 1 ? 'file' : 'files'}</div>
        <Button
          variant="ghost"
          size="sm"
          disabled={!files.length || allSelected}
          onClick={() => onSelectAll(files.map((file) => file.path))}
        >
          Stage all
        </Button>
      </div>

      {!status && <div style={{ marginTop: 18, color: C.textMuted, fontSize: 12 }}>Reading working changes…</div>}
      {status && !files.length && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 18, color: C.green, fontSize: 12 }}>
          <CheckIcon size={12} color={C.green} />
          {status.clean ? 'No uncommitted changes' : 'No committable files'}
        </div>
      )}
      {files.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16, maxHeight: 320, overflow: 'auto' }}>
          {files.map((file) => {
            const kind = KIND[file.kind]
            return (
              <Checkbox
                key={file.path}
                checked={selected.has(file.path)}
                onChange={(checked) => onSelected(file.path, checked)}
                title={file.path}
                style={{ minWidth: 0 }}
              >
                <span style={{ width: 13, flex: 'none', color: kind.color, fontFamily: MONO, fontWeight: 700 }}>
                  {kind.letter}
                </span>
                <span style={{ minWidth: 0, ...ELLIPSIS, fontFamily: MONO }}>
                  {file.path}
                </span>
              </Checkbox>
            )
          })}
        </div>
      )}
    </section>
  )
}

function CommitCard({
  provider,
  model,
  settings,
  draft,
  selectedCount,
  gitAction,
  commitReason,
  pushReason,
  ahead,
  onDraftMessage,
  onPrepare,
  onSelectionChange,
  onCommit,
  onPush
}: {
  provider: AiProvider
  model?: string
  settings: AppSettings
  draft: ReturnType<typeof useGitPanel>['draft']
  selectedCount: number
  gitAction: GitAction | null
  commitReason: string | null
  pushReason: string | null
  ahead: number
  onDraftMessage: (message: string) => void
  onPrepare: () => void
  onSelectionChange: (provider: AiProvider, model: string | undefined) => void
  onCommit: () => void
  onPush: () => void
}) {
  const selectedReason = selectedCount ? null : 'Select at least one file to commit.'
  const blocked = commitReason ?? selectedReason
  const canGenerate = !blocked && !gitAction
  const canCommit = canGenerate && !!draft.message.trim()
  const canPush = !pushReason && !gitAction

  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div style={sectionLabel}>Commit message</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <CliModelDropdown
            label="Commit message model"
            provider={provider}
            model={model}
            settings={settings}
            onChange={onSelectionChange}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!canGenerate}
            title={blocked ?? `Generate with ${aiSelectionLabel(provider, model)}`}
            onClick={onPrepare}
          >
            {gitAction === 'generate' ? <><Spinner /> Generating…</> : 'Generate with AI'}
          </Button>
        </div>
      </div>
      {draft.skipped.length > 0 && (
        <div style={{ marginBottom: 8, color: C.yellow, fontSize: 11, overflowWrap: 'anywhere' }}>
          Excluded possible secrets: {draft.skipped.join(', ')}
        </div>
      )}
      <textarea
        className="bf-input bf-focus"
        value={draft.message}
        onChange={(event) => onDraftMessage(event.target.value)}
        rows={5}
        disabled={gitAction === 'commit'}
        placeholder="Summarize your changes…"
        spellCheck={false}
        aria-label="Commit message"
        style={{
          ...input,
          minHeight: 96,
          maxHeight: 180,
          resize: 'vertical',
          padding: '10px 12px',
          fontFamily: MONO,
          lineHeight: 1.5
        }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Button
          variant="primary"
          size="md"
          disabled={!canCommit}
          title={blocked ?? (!draft.message.trim() ? 'Enter a commit message.' : undefined)}
          onClick={onCommit}
          style={{ flex: 1, height: 34, borderRadius: 8 }}
        >
          {gitAction === 'commit' ? <><Spinner /> Committing…</> : `Commit (${selectedCount})`}
        </Button>
        <HoldButton
          label={`Push${ahead > 0 ? ` (${ahead})` : ''}`}
          busyLabel="Pushing…"
          busy={gitAction === 'push'}
          disabled={!canPush}
          title={pushReason ?? `Hold to push ${ahead} commit${ahead === 1 ? '' : 's'}`}
          onConfirm={onPush}
          style={{ height: 34, borderRadius: 8 }}
        />
      </div>
    </section>
  )
}

function RecentCommitsCard({ commits }: { commits: ReturnType<typeof useGitPanel>['commits'] }) {
  return (
    <section style={{ ...card, flex: 1 }}>
      <div style={{ ...sectionLabel, marginBottom: 14 }}>Latest commits</div>
      {!commits.length && <div style={{ color: C.textMuted, fontSize: 12 }}>No commits yet</div>}
      {commits.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 360, overflow: 'auto' }}>
          {commits.map((commit, index) => (
            <div key={commit.hash} style={{ position: 'relative', display: 'grid', gridTemplateColumns: '14px minmax(0, 1fr) auto', columnGap: 10, paddingBottom: index === commits.length - 1 ? 0 : 16 }}>
              {index < commits.length - 1 && (
                <span style={{ position: 'absolute', top: 9, bottom: -2, left: 4, width: 1, background: C.border }} />
              )}
              <span style={{ width: 7, height: 7, marginTop: 5, borderRadius: '50%', background: index === 0 ? C.green : C.sidebar, border: `1px solid ${index === 0 ? C.green : C.faint}`, zIndex: 1 }} />
              <div style={{ minWidth: 0 }}>
                <div title={commit.subject} style={{ ...ELLIPSIS, color: C.textSoft, fontSize: 12, fontWeight: 600 }}>
                  {commit.subject}
                </div>
                <div style={{ marginTop: 3, color: C.textMuted, fontSize: 11 }}>
                  {commit.author}{commit.when ? ` · ${commit.when}` : ''}
                </div>
              </div>
              <span style={{ color: C.textMuted, fontFamily: MONO, fontSize: 10 }}>{commit.hash}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function ConflictPaths({ title, files }: { title: string; files: string[] }) {
  if (!files.length) return null
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ color: C.red, fontSize: 11, marginBottom: 5 }}>{title}</div>
      {files.map((file) => (
        <div key={file} title={file} style={{ color: C.textMuted, fontFamily: MONO, fontSize: 10, ...ELLIPSIS }}>
          {file}
        </div>
      ))}
    </div>
  )
}

const CHECK_GLYPH: Record<PrCheckState, { mark: string; color: string }> = {
  passed: { mark: '✓', color: C.green },
  failed: { mark: '✕', color: C.red },
  pending: { mark: '●', color: C.yellow },
  skipped: { mark: '–', color: C.textMuted },
  neutral: { mark: '○', color: C.textMuted }
}

/** Human-readable Actions roll-up for the Pull request card. */
function checksSummaryLabel(summary: PrCheckSummary): string {
  if (summary.state === 'unavailable') return 'GitHub Actions status unavailable'
  if (summary.state === 'none') return 'No GitHub Actions checks'
  if (summary.state === 'pending') {
    return `Checks running · ${summary.pending} pending`
  }
  if (summary.state === 'failed') {
    return `Checks failing · ${summary.failed} failed`
  }
  return `Checks passed · ${summary.passed} passed`
}

function CheckRows({ checks }: { checks: PrCheck[] }) {
  if (!checks.length) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
      {checks.map((check) => {
        const glyph = CHECK_GLYPH[check.state]
        return (
          <div
            key={check.name}
            style={{
              display: 'grid',
              gridTemplateColumns: '14px minmax(0, 1fr) auto',
              gap: 8,
              alignItems: 'center',
              color: C.textMuted,
              fontSize: 11
            }}
          >
            <span aria-hidden style={{ color: glyph.color, fontFamily: MONO, fontWeight: 700 }}>
              {glyph.mark}
            </span>
            <span
              title={check.name}
              style={{ minWidth: 0, ...ELLIPSIS }}
            >
              {check.name}
              {check.required ? ' · required' : ''}
            </span>
            <span style={{ color: glyph.color, textTransform: 'capitalize' }}>{check.state}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Base branches a pull request from `branch` can target, and the one in effect.
 * The current branch cannot be its own base. Remote-only bases are shown by branch
 * name: `gh pr create --base` wants `staging`, not `origin/staging`.
 */
function resolvePrBase(
  branch: string,
  branches: string[],
  remotes: string[],
  knownBase: string,
  userBase: string | null
): { baseOptions: string[]; base: string } {
  const baseOptions = [
    ...new Set([
      ...(knownBase ? [knownBase] : []),
      ...branches,
      ...remotes.map((name) => name.replace(/^[^/]+\//, ''))
    ])
  ].filter((name) => name && name !== branch)
  const preferred = ['staging', 'main', 'master', 'develop']
    .map((name) => baseOptions.find((option) => option === name || option.endsWith(`/${name}`)))
    .find(Boolean)
  // An open pull request's base is fixed; the saved selection only applies without one.
  const base = knownBase || (userBase && baseOptions.includes(userBase) ? userBase : '') || preferred || ''
  return { baseOptions, base }
}

function PullRequestCard({
  branch,
  status,
  github,
  gitAction,
  baseOptions,
  base,
  prDraft,
  provider,
  model,
  settings,
  mergeStrategy,
  onBase,
  onPrTitle,
  onPrDescription,
  onSelectionChange,
  onPreparePr,
  onMergeStrategy,
  onCheckConflicts,
  onCreatePr,
  onMergePr
}: {
  branch: string
  status: GitStatus | null
  github: GitHubInfo | null
  gitAction: GitAction | null
  baseOptions: string[]
  base: string
  prDraft: PrDraft
  provider: AiProvider
  model?: string
  settings: AppSettings
  mergeStrategy: MergeStrategy | ''
  onBase: (base: string) => void
  onPrTitle: (title: string) => void
  onPrDescription: (description: string) => void
  onSelectionChange: (provider: AiProvider, model: string | undefined) => void
  onPreparePr: (base: string) => void
  onMergeStrategy: (strategy: MergeStrategy | '') => void
  onCheckConflicts: () => void
  onCreatePr: (base: string, title: string, body: string) => void
  onMergePr: (strategy: MergeStrategy) => void
}) {
  const attached = github?.available ? github.prs[0] : undefined
  const mergeLoaded = !!status?.conflicts.length || !!github || !!status?.baseMerge
  const mergeItems = mergeLoaded ? conflictStatusItems(status, github) : []
  const working = (status?.conflicts ?? []).map((file) => file.path)
  const workingSet = new Set(working)
  const predicted = (github?.conflictFiles ?? []).filter((file) => !workingSet.has(file))
  const canCheck =
    !gitAction &&
    !!status &&
    (status.clean || status.conflicts.length > 0) &&
    (working.length > 0 || !!conflictMergeBase(status, github))
  const checkTitle = !status
    ? 'Reading working changes…'
    : gitAction
      ? 'Wait for the current Git action to finish'
      : canCheck
        ? 'Merge the pull request base if needed, then send conflicted files to Chat'
        : !working.length && !conflictMergeBase(status, github)
          ? 'No pull request or base branch to check.'
        : 'Commit or stash local changes before merging the pull request base'
  const prReason = github === null
    ? 'Reading GitHub status…'
    : !github.available
      ? github.message || 'GitHub is unavailable.'
      : pullRequestBlockReason(status)
  const canCreatePr = !attached && !prReason && !gitAction
  const canGeneratePr = !attached && !!base && !gitAction
  const mergeReason = attached
    ? mergePullRequestBlockReason(attached, mergeStrategy || null)
    : 'No open pull request from this branch.'
  const canMerge = !!attached && !mergeReason && !gitAction
  const checks = attached?.checks

  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div style={sectionLabel}>Pull request</div>
        {!attached && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CliModelDropdown
              label="Pull request model"
              provider={provider}
              model={model}
              settings={settings}
              onChange={onSelectionChange}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!canGeneratePr}
              title={
                !base
                  ? 'Choose a base branch before generating.'
                  : gitAction
                    ? 'Wait for the current Git action to finish'
                    : `Generate with ${aiSelectionLabel(provider, model)}`
              }
              onClick={() => onPreparePr(base)}
            >
              {gitAction === 'generatePr' ? <><Spinner /> Generating…</> : 'Generate with AI'}
            </Button>
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={{ minWidth: 0, color: C.textMuted, fontSize: 11 }}>
          Compare
          <input className="bf-input" value={branch} readOnly aria-label="Compare branch" style={{ ...input, height: 34, marginTop: 6, fontFamily: MONO }} />
        </label>
        <label style={{ minWidth: 0, color: C.textMuted, fontSize: 11 }}>
          Base
          <select
            className="bf-input bf-focus"
            value={base}
            onChange={(event) => onBase(event.target.value)}
            disabled={!!attached}
            aria-label="Base branch"
            style={{ ...input, height: 34, marginTop: 6, fontFamily: MONO }}
          >
            <option value="">Repository default</option>
            {baseOptions.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ marginTop: 12, padding: '5px 6px 5px 11px', minHeight: 32, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${C.border}`, borderRadius: 8, background: C.terminal }}>
        <span style={{ width: 8, height: 8, flex: 'none', borderRadius: '50%', background: mergeItems.some((item) => item.tone === 'conflict') ? C.red : mergeItems.some((item) => item.tone === 'ok') ? C.green : C.faint }} />
        <span style={{ flex: 1, minWidth: 0, color: C.textMuted, fontSize: 11 }}>
          {mergeItems[0]?.text ?? 'Merge status unknown'}
        </span>
        <ConfirmButton
          label="Check conflicts"
          confirmLabel="Confirm check"
          busyLabel="Checking…"
          busy={gitAction === 'conflicts'}
          disabled={!canCheck}
          title={checkTitle}
          onConfirm={onCheckConflicts}
        />
      </div>

      {mergeItems.slice(1).map((item) => (
        <div key={item.text} style={{ marginTop: 7, color: item.tone === 'conflict' ? C.red : C.textMuted, fontSize: 11 }}>
          {item.text}
        </div>
      ))}
      <ConflictPaths title="Working tree conflicts" files={working} />
      <ConflictPaths title="Predicted conflicts" files={predicted} />

      {attached && checks && (
        <div style={{ marginTop: 12, padding: '10px 12px', border: `1px solid ${C.border}`, borderRadius: 8, background: C.terminal }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 8,
                height: 8,
                flex: 'none',
                borderRadius: '50%',
                background:
                  checks.state === 'passed' || checks.state === 'none'
                    ? C.green
                    : checks.state === 'failed'
                      ? C.red
                      : checks.state === 'pending'
                        ? C.yellow
                        : C.faint
              }}
            />
            <span style={{ color: C.textSoft, fontSize: 11, fontWeight: 600 }}>
              {checksSummaryLabel(checks)}
            </span>
          </div>
          <CheckRows checks={checks.checks} />
        </div>
      )}

      {!attached && (
        <>
          <input
            className="bf-input bf-focus"
            value={prDraft.title}
            onChange={(event) => onPrTitle(event.target.value)}
            placeholder="Pull request title (optional)"
            aria-label="Pull request title"
            style={{ ...input, height: 36, marginTop: 12 }}
          />
          <textarea
            className="bf-input bf-focus"
            value={prDraft.description}
            onChange={(event) => onPrDescription(event.target.value)}
            rows={4}
            placeholder="Pull request description (optional)"
            aria-label="Pull request description"
            spellCheck={false}
            style={{
              ...input,
              minHeight: 88,
              maxHeight: 180,
              resize: 'vertical',
              marginTop: 8,
              padding: '10px 12px',
              lineHeight: 1.5
            }}
          />
          <HoldButton
            label="Create pull request"
            busyLabel="Creating pull request…"
            busy={gitAction === 'pr'}
            disabled={!canCreatePr}
            title={prReason ?? 'Hold to create a pull request on GitHub'}
            onConfirm={() => onCreatePr(base, prDraft.title, prDraft.description)}
            style={{ width: '100%', height: 38, marginTop: 10, borderRadius: 8 }}
          />
          {prReason && <div style={{ marginTop: 7, color: C.textMuted, fontSize: 11 }}>{prReason}</div>}
        </>
      )}

      {attached && (
        <>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <select
            className="bf-input bf-focus"
            value={mergeStrategy}
            onChange={(event) => onMergeStrategy(event.target.value as MergeStrategy | '')}
            aria-label="Merge strategy"
            style={{ ...input, height: 38, flex: '0 0 140px', fontFamily: MONO }}
          >
            <option value="">Strategy…</option>
            {MERGE_STRATEGIES.map((strategy) => (
              <option key={strategy} value={strategy}>
                {strategy}
              </option>
            ))}
          </select>
          <HoldButton
            label={`Merge #${attached.number}`}
            busyLabel="Merging…"
            busy={gitAction === 'merge'}
            disabled={!canMerge}
            title={mergeReason ?? `Hold to ${mergeStrategy} merge pull request #${attached.number}`}
            onConfirm={() => {
              if (!mergeStrategy) return
              onMergePr(mergeStrategy)
            }}
            style={{ flex: 1, height: 38, borderRadius: 8 }}
          />
          {attached.url && (
            <Button
              variant="secondary"
              size="md"
              title={`Open pull request #${attached.number} on GitHub`}
              onClick={() => window.open(attached.url, '_blank', 'noopener,noreferrer')}
              style={{ flex: 'none', height: 38, borderRadius: 8 }}
            >
              Open
            </Button>
          )}
        </div>
        {mergeReason && <div style={{ marginTop: 7, color: C.textMuted, fontSize: 11 }}>{mergeReason}</div>}
        </>
      )}
    </section>
  )
}

function GitLogCard({ log }: { log: GitLogEntry[] }) {
  return (
    <section style={{ ...card, flex: 1, minHeight: 144 }}>
      <div style={{ ...sectionLabel, marginBottom: 14 }}>Git log</div>
      <div role="log" aria-live="polite" style={{ minHeight: 84, maxHeight: 220, overflow: 'auto', borderRadius: 8, background: C.terminal, padding: '11px 12px', boxSizing: 'border-box', fontFamily: MONO, fontSize: 10, lineHeight: 1.6 }}>
        {!log.length && <span style={{ color: C.faint }}>No Git actions this session.</span>}
        {log.map((entry) => (
          <div key={entry.id} style={{ display: 'grid', gridTemplateColumns: '58px max-content minmax(0, 1fr)', gap: 8, color: entry.ok ? C.textMuted : C.red }}>
            <span style={{ color: C.faint }}>{entry.time}</span>
            <span style={{ color: entry.ok ? C.green : C.red }}>{entry.action}</span>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{entry.message}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function HooksCard({ hooks }: { hooks: GitHookInfo[] | null }) {
  const list = hooks ?? []
  const commitHooks = new Set(activeHooks(list, 'commit').map((hook) => hook.name))
  const pushHooks = new Set(activeHooks(list, 'push').map((hook) => hook.name))

  return (
    <section style={card}>
      <div style={{ ...sectionLabel, marginBottom: 14 }}>Git hooks</div>
      {!hooks && <div style={{ color: C.textMuted, fontSize: 12 }}>Reading hooks…</div>}
      {hooks && !list.length && (
        <div style={{ color: C.textMuted, fontSize: 12 }}>No hooks installed in this repository.</div>
      )}
      {list.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map((hook) => {
            const blocks = [
              ...(commitHooks.has(hook.name) ? ['commit'] : []),
              ...(pushHooks.has(hook.name) ? ['push'] : [])
            ]
            return (
              <div key={hook.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }} title={hook.path}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    flex: 'none',
                    borderRadius: '50%',
                    background: hook.enabled ? C.green : C.faint
                  }}
                />
                <span style={{ fontFamily: MONO, fontSize: 12, color: C.textSoft }}>{hook.name}</span>
                {!hook.enabled && <span style={{ color: C.textMuted, fontSize: 10 }}>disabled</span>}
                {blocks.length > 0 && (
                  <span style={{ color: C.yellow, fontSize: 10 }}>
                    blocks {blocks.join(' & ')}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

export default function GitPane({
  branch,
  branches,
  remotes,
  provider,
  model,
  settings,
  onCommitMessageModelChange,
  status,
  commits,
  github,
  hooks,
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
  setDraftMessage,
  setPrTitle,
  setPrDescription,
  setFileSelected,
  selectAllFiles,
  confirmCommit,
  push,
  createPr,
  mergePr,
  resolveConflicts,
  setConflictBase,
  open,
  onClose,
  anchorRef
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [prBase, setPrBase] = useState<string | null>(null)
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy | ''>('')
  useEscapeClose(open, onClose)
  useFocusTrap(open, dialogRef)
  const [commitProvider, setCommitProvider] = useState(provider)
  const [commitModel, setCommitModel] = useState<string | undefined>(normalizeModel(model))
  const [prProvider, setPrProvider] = useState(provider)
  const [prModel, setPrModel] = useState<string | undefined>(normalizeModel(model))

  useEffect(() => {
    setCommitProvider(provider)
    setCommitModel(normalizeModel(model))
    setPrProvider(provider)
    setPrModel(normalizeModel(model))
  }, [provider, model])

  useEffect(() => {
    if (!open) return
    return () => anchorRef.current?.focus()
  }, [anchorRef, open])

  const attachedBase = github?.available ? github.prs[0]?.base : undefined
  const { baseOptions, base } = resolvePrBase(branch, branches, remotes, attachedBase ?? '', prBase)

  // Until the poll reports on the base now in effect, don't show the previous base's result.
  const baseStatus =
    status?.baseMerge && status.baseMerge.base !== base ? { ...status, baseMerge: undefined } : status

  // A base picked for one branch should not carry over to another.
  useEffect(() => {
    setPrBase(null)
  }, [branch])

  // The conflict check follows whichever base is in effect.
  useEffect(() => {
    setConflictBase(base || undefined)
  }, [base, setConflictBase])

  if (!open) return null

  const commitReason = status ? commitBlockReason(status) : 'Reading working changes…'
  const pushReason = status ? pushBlockReason(status) : 'Reading remote status…'

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Source Control"
      tabIndex={-1}
      style={{ position: 'fixed', inset: 0, zIndex: 90, display: 'flex', flexDirection: 'column', background: C.terminal, color: C.text, fontFamily: UI }}
    >
      <header style={{ height: 52, flex: 'none', display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 13, fontWeight: 650 }}>Source Control</span>
        <span style={{ maxWidth: 320, ...ELLIPSIS, padding: '5px 9px', border: `1px solid ${C.border}`, borderRadius: 6, background: C.sidebar, color: C.textSoft, fontFamily: MONO, fontSize: 11 }}>
          {branch}{base ? ` → ${base}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {loading && <span style={{ color: C.textMuted, fontSize: 11 }}>Updating…</span>}
        {status && status.ahead > 0 && (
          <span style={{ color: C.textMuted, fontSize: 11 }}>
            {status.ahead} {status.ahead === 1 ? 'commit' : 'commits'} ahead
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={refresh}
          title={refreshError ?? 'Refresh status and GitHub checks'}
          aria-label="Refresh"
        >
          <RefreshIcon size={13} />
        </Button>
        <Button variant="ghost" size="sm" autoFocus onClick={onClose}>Done</Button>
      </header>

      <main style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 20 }}>
        <div className="bf-source-control-grid" style={{ maxWidth: 1380, margin: '0 auto' }}>
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <ChangesCard status={status} selectedFiles={selectedFiles} onSelected={setFileSelected} onSelectAll={selectAllFiles} />
            <CommitCard
              provider={commitProvider}
              model={commitModel}
              settings={settings}
              draft={draft}
              selectedCount={selectedFiles.length}
              gitAction={gitAction}
              commitReason={commitReason}
              pushReason={pushReason}
              ahead={status?.ahead ?? 0}
              onDraftMessage={setDraftMessage}
              onPrepare={() => void prepareCommit(commitProvider, commitModel)}
              onSelectionChange={(nextProvider, nextModel) => {
                setCommitProvider(nextProvider)
                setCommitModel(nextModel)
                onCommitMessageModelChange(nextProvider, nextModel)
              }}
              onCommit={confirmCommit}
              onPush={push}
            />
            <RecentCommitsCard commits={commits} />
          </div>
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <PullRequestCard
              branch={branch}
              status={baseStatus}
              github={github}
              gitAction={gitAction}
              baseOptions={baseOptions}
              base={base}
              prDraft={prDraft}
              provider={prProvider}
              model={prModel}
              settings={settings}
              mergeStrategy={mergeStrategy}
              onBase={setPrBase}
              onPrTitle={setPrTitle}
              onPrDescription={setPrDescription}
              onSelectionChange={(nextProvider, nextModel) => {
                setPrProvider(nextProvider)
                setPrModel(nextModel)
              }}
              onPreparePr={(nextBase) => void preparePr(nextBase, prProvider, prModel)}
              onMergeStrategy={setMergeStrategy}
              onCheckConflicts={resolveConflicts}
              onCreatePr={createPr}
              onMergePr={(strategy) => {
                void mergePr(strategy)
                setMergeStrategy('')
              }}
            />
            <HooksCard hooks={hooks} />
            <GitLogCard log={log} />
          </div>
        </div>
      </main>
    </div>,
    document.body
  )
}
