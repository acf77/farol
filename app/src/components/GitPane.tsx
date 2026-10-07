import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
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
  type AiProvider,
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
import { BranchDropdown, Button } from './controls'
import { Field, HAIR, Seg, SettingsGroup, SparkIcon, fieldBox } from './editor-ui'
import { BranchIcon, CheckIcon, ChevronsUpDown, RefreshIcon, Spinner } from './icons'

interface Props extends ReturnType<typeof useGitPanel> {
  branch: string
  branches: string[]
  remotes: string[]
  provider: AiProvider
  model?: string
  open: boolean
  onClose: () => void
  anchorRef: RefObject<HTMLElement | null>
}

export function gitStatusDotColor(status: GitStatus | null, github: GitHubInfo | null): string {
  if (conflictSignals(status, github).any) return C.red
  if (!status) return C.textMuted
  return status.clean ? C.green : C.yellow
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
  style,
  primary
}: {
  label: string
  busyLabel: string
  busy: boolean
  disabled: boolean
  title: string
  onConfirm: () => void
  style?: CSSProperties
  /** Lime at rest, with a darker sweep so the hold progress stays visible. */
  primary?: boolean
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

  const prevDisabled = useRef(disabled)
  useEffect(() => {
    if (disabled && !prevDisabled.current) cancel()
    prevDisabled.current = disabled
  }, [cancel, disabled])

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
      variant={primary ? 'primary' : 'secondary'}
      size="md"
      disabled={disabled || busy}
      title={holding ? 'Keep holding to confirm' : title}
      aria-label={`${label}. Hold until the button fills to confirm`}
      aria-disabled={disabled || busy}
      className={`bf-hold-btn${primary ? ' is-primary' : ''}${holding ? ' is-holding' : ''}`}
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
        color: holding || primary ? C.accentInk : undefined,
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

const BG = 'oklch(0.17 0.006 95)'
const CARD_BORDER = 'oklch(1 0 0 / 0.08)'
const SOFT_BORDER = 'oklch(1 0 0 / 0.06)'
const WELL = 'oklch(0.15 0.004 95)'
const AI_FILL = 'oklch(0.73 0.16 300 / 0.12)'
const BLOCKS = 'oklch(0.82 0.12 80)'

const sectionLabel: CSSProperties = {
  color: C.faint,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase'
}

const card: CSSProperties = {
  borderRadius: 12,
  background: C.sidebar,
  border: `1px solid ${CARD_BORDER}`,
  minWidth: 0
}

const KIND: Record<GitFileKind, { letter: string; color: string }> = {
  modified: { letter: 'M', color: BLOCKS },
  added: { letter: 'A', color: C.green },
  deleted: { letter: 'D', color: C.red },
  renamed: { letter: 'R', color: C.purpleSoft },
  untracked: { letter: 'U', color: C.accent },
  conflict: { letter: '!', color: C.red }
}

function splitPath(path: string): { dir: string; file: string } {
  const slash = path.lastIndexOf('/') + 1
  return { dir: path.slice(0, slash), file: path.slice(slash) }
}

function PathLabel({ path, size }: { path: string; size: number }) {
  const { dir, file } = splitPath(path)
  return (
    <span title={path} style={{ flex: 1, minWidth: 0, ...ELLIPSIS, fontFamily: MONO, fontSize: size }}>
      <span style={{ color: C.faint }}>{dir}</span>
      {file}
    </span>
  )
}

function Section({ label, meta, action, children }: { label: string; meta?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={sectionLabel}>{label}</span>
        {meta && <span style={{ fontSize: 11, color: C.fainter }}>{meta}</span>}
        <span style={{ flex: 1 }} />
        {action}
      </div>
      {children}
    </div>
  )
}

/** Quiet text action used beside section labels and inside status wells. */
function LinkButton({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="bf-focus bf-link-btn"
      disabled={disabled}
      onClick={onClick}
      style={{ padding: 0, border: 'none', background: 'transparent', font: 'inherit', fontSize: 12, color: C.textRow, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1 }}
    >
      {children}
    </button>
  )
}

function AiButton({ busy, disabled, title, onClick, style, label = 'Draft with AI', busyLabel = 'Drafting…' }: { busy: boolean; disabled: boolean; title?: string; onClick: () => void; style?: CSSProperties; label?: string; busyLabel?: string }) {
  return (
    <button
      type="button"
      className="bf-focus bf-ai-btn"
      disabled={disabled}
      title={title}
      onClick={onClick}
      style={{ flex: 'none', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '5px 10px', border: 'none', borderRadius: 7, background: AI_FILL, color: C.purpleSoft, font: 'inherit', fontSize: 12, fontWeight: 500, cursor: disabled ? 'default' : 'pointer', opacity: disabled && !busy ? 0.5 : 1, ...style }}
    >
      {busy ? <Spinner size={12} color={C.purpleSoft} /> : <SparkIcon />}
      <span>{busy ? busyLabel : label}</span>
    </button>
  )
}

/** Files listed before the rest fold behind "Show more". */
const CHANGES_PREVIEW = 5

function ChangesSection({
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
  const [expanded, setExpanded] = useState(false)
  const collapsible = files.length > CHANGES_PREVIEW
  const shown = collapsible && !expanded ? files.slice(0, CHANGES_PREVIEW) : files

  return (
    <Section
      label="Changes"
      meta={files.length ? `${files.filter((file) => selected.has(file.path)).length} of ${files.length} staged` : undefined}
      action={
        files.length > 0 && (
          <LinkButton onClick={() => onSelectAll(allSelected ? [] : files.map((file) => file.path))}>
            {allSelected ? 'Unstage all' : 'Stage all'}
          </LinkButton>
        )
      }
    >
      <div style={{ ...card, overflow: 'hidden' }}>
        {!status && <div style={{ padding: 14, color: C.textMuted, fontSize: 12.5 }}>Reading working changes…</div>}
        {status && !files.length && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 14, color: C.textMuted, fontSize: 12.5 }}>
            <CheckIcon size={12} color={C.green} />
            <span>{status.clean ? 'Working tree clean' : 'No committable files'}</span>
          </div>
        )}
        {shown.map((file, index) => {
          const kind = KIND[file.kind]
          const on = selected.has(file.path)
          return (
            <label
              key={file.path}
              className="bf-file-row"
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', cursor: 'pointer', borderBottom: index === shown.length - 1 && !collapsible ? 'none' : `1px solid ${SOFT_BORDER}` }}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={(event) => onSelected(file.path, event.target.checked)}
                style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
              />
              <span
                aria-hidden
                className="bf-file-box"
                style={{ width: 15, height: 15, borderRadius: 4, flex: 'none', display: 'grid', placeItems: 'center', background: on ? C.accent : 'transparent', border: `1px solid ${on ? C.accent : C.fainter}` }}
              >
                {on && <CheckIcon size={9} color={C.accentInk} strokeWidth={3} />}
              </span>
              <span style={{ width: 12, fontFamily: MONO, fontSize: 11, fontWeight: 600, color: kind.color }}>{kind.letter}</span>
              <PathLabel path={file.path} size={12} />
              {!!file.added && <span style={{ fontFamily: MONO, fontSize: 11, color: C.green }}>+{file.added}</span>}
              {!!file.removed && <span style={{ fontFamily: MONO, fontSize: 11, color: C.red }}>−{file.removed}</span>}
            </label>
          )
        })}
        {collapsible && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 14px' }}>
            <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
              {expanded ? 'Show less' : `Show more (${files.length - CHANGES_PREVIEW})`}
            </Button>
          </div>
        )}
      </div>
    </Section>
  )
}

function CommitSection({
  provider,
  model,
  draft,
  selectedCount,
  gitAction,
  commitReason,
  pushReason,
  ahead,
  onDraftMessage,
  onPrepare,
  onCommit,
  onPush
}: {
  provider: AiProvider
  model?: string
  draft: ReturnType<typeof useGitPanel>['draft']
  selectedCount: number
  gitAction: GitAction | null
  commitReason: string | null
  pushReason: string | null
  ahead: number
  onDraftMessage: (message: string) => void
  onPrepare: () => void
  onCommit: () => void
  onPush: () => void
}) {
  const selectedReason = selectedCount ? null : 'Select at least one file to commit.'
  const blocked = commitReason ?? selectedReason
  const canGenerate = !blocked && !gitAction
  const canCommit = canGenerate && !!draft.message.trim()
  const canPush = !pushReason && !gitAction

  return (
    <Section label="Commit">
      <div style={card}>
        {draft.skipped.length > 0 && (
          <div style={{ padding: '10px 14px 0', color: C.yellow, fontSize: 11, overflowWrap: 'anywhere' }}>
            Excluded possible secrets: {draft.skipped.join(', ')}
          </div>
        )}
        <textarea
          value={draft.message}
          onChange={(event) => onDraftMessage(event.target.value)}
          rows={4}
          disabled={gitAction === 'commit'}
          placeholder="Summarize your changes…"
          spellCheck={false}
          aria-label="Commit message"
          style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: 14, border: 'none', background: 'transparent', color: C.text, fontFamily: MONO, fontSize: 12.5, lineHeight: 1.6, resize: 'vertical', outline: 'none' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderTop: `1px solid ${SOFT_BORDER}` }}>
          <AiButton
            busy={gitAction === 'generate'}
            disabled={!canGenerate}
            title={blocked ?? `Generate with ${aiSelectionLabel(provider, model)}`}
            onClick={onPrepare}
          />
          <span style={{ flex: 1 }} />
          <HoldButton
            label={`Push${ahead > 0 ? ` ${ahead}` : ''}`}
            busyLabel="Pushing…"
            busy={gitAction === 'push'}
            disabled={!canPush}
            title={pushReason ?? `Hold to push ${ahead} commit${ahead === 1 ? '' : 's'}`}
            onConfirm={onPush}
            style={{ flex: 'none', height: 30, padding: '0 14px', borderRadius: 7, background: C.panel, border: `1px solid ${SOFT_BORDER}`, color: C.text, fontSize: 12.5, fontWeight: 500 }}
          />
          <Button
            variant="primary"
            size="md"
            disabled={!canCommit}
            title={blocked ?? (!draft.message.trim() ? 'Enter a commit message.' : undefined)}
            onClick={onCommit}
            style={{ height: 30, padding: '0 16px', borderRadius: 7, fontSize: 12.5, opacity: canCommit ? 1 : 0.4, background: C.accent }}
          >
            {gitAction === 'commit' ? <><Spinner color={C.accentInk} /> Committing…</> : `Commit${selectedCount ? ` ${selectedCount}` : ''}`}
          </Button>
        </div>
      </div>
    </Section>
  )
}

function HistorySection({ commits, unpushed }: { commits: ReturnType<typeof useGitPanel>['commits']; unpushed: number }) {
  return (
    <Section label="History">
      {!commits.length && <div style={{ color: C.textMuted, fontSize: 12.5 }}>No commits yet</div>}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {commits.map((commit, index) => {
          const last = index === commits.length - 1
          return (
            <div key={commit.hash} style={{ display: 'flex', gap: 14 }}>
              <div style={{ width: 12, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: 9, height: 9, marginTop: 4, flex: 'none', borderRadius: '50%', background: index === 0 ? C.accent : BG, border: `1.5px solid ${index === 0 ? C.accent : C.fainter}` }} />
                <div style={{ width: 1, flex: 1, marginTop: 4, background: 'oklch(0.3 0.006 95)', opacity: last ? 0 : 1 }} />
              </div>
              <div style={{ flex: 1, minWidth: 0, paddingBottom: 18 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                  <span title={commit.subject} style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, ...ELLIPSIS }}>{commit.subject}</span>
                  <span style={{ flex: 'none', fontFamily: MONO, fontSize: 11, color: C.faint }}>{commit.hash}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 3, fontSize: 11.5, color: C.faint }}>
                  <span>{commit.author}{commit.when ? ` · ${commit.when}` : ''}</span>
                  {index < unpushed && (
                    <span style={{ padding: '1px 7px', borderRadius: 20, background: 'oklch(1 0 0 / 0.05)', fontSize: 10.5, color: C.textRow }}>not pushed</span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function ConflictPaths({ title, files }: { title: string; files: string[] }) {
  if (!files.length) return null
  return (
    <div style={{ borderTop: `1px solid ${SOFT_BORDER}` }}>
      <div style={{ padding: '9px 12px 0', color: C.red, fontSize: 11 }}>{title}</div>
      {files.map((file) => (
        <div key={file} style={{ display: 'flex', alignItems: 'center', padding: '7px 12px' }}>
          <PathLabel path={file} size={11.5} />
        </div>
      ))}
    </div>
  )
}

/** Human-readable Actions roll-up for the Pull request card. */
function checksSummaryLabel(summary: PrCheckSummary): string {
  if (summary.state === 'unavailable') return 'GitHub Actions status unavailable'
  if (summary.state === 'none') return 'No GitHub Actions checks'
  if (summary.state === 'pending') return `Checks running · ${summary.pending} pending`
  if (summary.state === 'failed') return `Checks failing · ${summary.failed} failed`
  return `Checks passed · ${summary.passed} passed`
}

const CHECK_LABEL: Record<PrCheckState, { text: string; color: string }> = {
  passed: { text: 'Passed', color: C.green },
  failed: { text: 'Failed', color: C.red },
  pending: { text: 'Running', color: BLOCKS },
  skipped: { text: 'Skipped', color: C.faint },
  neutral: { text: 'Neutral', color: C.faint }
}

function CheckRows({ checks }: { checks: PrCheck[] }) {
  return (
    <>
      {checks.map((check) => {
        const label = CHECK_LABEL[check.state]
        return (
          <div key={check.name} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 15, fontSize: 11.5 }}>
            <span title={check.name} style={{ flex: 1, minWidth: 0, color: C.textMuted, ...ELLIPSIS }}>
              {check.name}
              {check.required ? ' · required' : ''}
            </span>
            <span style={{ flex: 'none', fontSize: 11, color: label.color }}>{label.text}</span>
          </div>
        )
      })}
    </>
  )
}

const STRATEGY_COPY: Record<MergeStrategy, { label: string; short: string; hint: (base: string) => string }> = {
  squash: { label: 'Squash and merge', short: 'Squash', hint: (base) => `One commit on ${base}` },
  merge: { label: 'Merge commit', short: 'Merge', hint: () => 'Keep every commit' },
  rebase: { label: 'Rebase and merge', short: 'Rebase', hint: () => 'Replay commits, no merge commit' }
}

/** Merge-strategy picker that opens upward from the merge row, per the design. */
function StrategyMenu({ value, base, onChange }: { value: MergeStrategy | ''; base: string; onChange: (strategy: MergeStrategy) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [open])

  return (
    <div
      ref={box}
      style={{ position: 'relative', flex: 'none' }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        event.stopPropagation()
        setOpen(false)
      }}
    >
      <button
        type="button"
        className="bf-focus"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Merge strategy"
        onClick={() => setOpen((on) => !on)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 10px', borderRadius: 7, background: C.sidebar, border: `1px solid ${C.border}`, color: C.text, font: 'inherit', fontSize: 12, cursor: 'pointer' }}
      >
        <span>{value ? STRATEGY_COPY[value].short : 'Strategy'}</span>
        <ChevronsUpDown size={9} color={C.faint} />
      </button>
      {open && (
        <div role="menu" style={{ position: 'absolute', bottom: 38, left: 0, zIndex: 20, width: 200, padding: 4, borderRadius: 8, background: C.panel, border: `1px solid ${C.border}`, boxShadow: '0 12px 32px rgba(0,0,0,.45)' }}>
          {(Object.keys(STRATEGY_COPY) as MergeStrategy[]).map((key) => (
            <button
              key={key}
              type="button"
              role="menuitemradio"
              aria-checked={key === value}
              className="bf-focus bf-menu-item"
              onClick={() => {
                onChange(key)
                setOpen(false)
              }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', border: 'none', borderRadius: 6, color: C.text, font: 'inherit', cursor: 'pointer', background: key === value ? 'oklch(1 0 0 / 0.07)' : 'transparent' }}
            >
              <div style={{ fontSize: 12.5 }}>{STRATEGY_COPY[key].label}</div>
              <div style={{ fontSize: 11, color: C.faint, marginTop: 2 }}>{STRATEGY_COPY[key].hint(base)}</div>
            </button>
          ))}
        </div>
      )}
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

function checksDot(state: PrCheckSummary['state']): string {
  if (state === 'passed' || state === 'none') return C.green
  if (state === 'failed') return C.red
  if (state === 'pending') return C.yellow
  return C.faint
}

function PullRequestTab({
  branch,
  status,
  github,
  gitAction,
  baseOptions,
  base,
  prDraft,
  provider,
  model,
  mergeStrategy,
  onBase,
  onPrTitle,
  onPrDescription,
  onPreparePr,
  onMergeStrategy,
  onFixConflicts,
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
  mergeStrategy: MergeStrategy | ''
  onBase: (base: string) => void
  onPrTitle: (title: string) => void
  onPrDescription: (description: string) => void
  onPreparePr: (base: string) => void
  onMergeStrategy: (strategy: MergeStrategy | '') => void
  onFixConflicts: () => void
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
  const fixTitle = !status
    ? 'Reading working changes…'
    : gitAction
      ? 'Wait for the current Git action to finish'
      : canCheck
        ? 'Merge the base into your working tree if needed, then send the conflicts to Chat to fix'
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
  const mergeLabel = !attached
    ? ''
    : attached.hasConflicts
      ? 'Resolve conflicts to merge'
      : checks?.state === 'pending'
        ? 'Waiting for checks'
        : `Merge #${attached.number}`
  const hasConflict = mergeItems.some((item) => item.tone === 'conflict')
  const hasConflictFiles = working.length > 0 || predicted.length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Field label="Merge into">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div title={branch} style={{ flex: 1, minWidth: 0, ...ELLIPSIS, padding: '8px 10px', borderRadius: 7, background: C.terminal, border: `1px solid ${SOFT_BORDER}`, fontFamily: MONO, fontSize: 12, color: C.textMuted }}>
            {branch}
          </div>
          <span style={{ flex: 'none', color: C.fainter }}>→</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <BranchDropdown
              value={base || 'Repository default'}
              groups={[{ label: 'Base branch', branches: baseOptions }]}
              disabled={!!attached}
              onChange={onBase}
              style={{ width: '100%', height: 34, borderRadius: 7, fontFamily: MONO, fontSize: 12, background: C.terminal, border: `1px solid ${C.border}` }}
            />
          </div>
        </div>
      </Field>

      <div style={{ borderRadius: 9, background: C.terminal, border: `1px solid ${SOFT_BORDER}`, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' }}>
          <span style={{ width: 7, height: 7, flex: 'none', borderRadius: '50%', background: hasConflict ? C.red : mergeItems.some((item) => item.tone === 'ok') ? C.green : C.faint }} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.4, color: C.textRow }}>
            {mergeItems[0]?.text ?? 'Merge status unknown'}
          </span>
          {hasConflict && (
            <AiButton
              label="Fix with AI"
              busyLabel="Fixing…"
              busy={gitAction === 'conflicts'}
              disabled={!canCheck}
              title={fixTitle}
              onClick={onFixConflicts}
            />
          )}
        </div>
        {mergeItems.slice(1).map((item) => (
          <div key={item.text} style={{ padding: '0 12px 10px 29px', color: item.tone === 'conflict' ? C.red : C.textMuted, fontSize: 11.5 }}>
            {item.text}
          </div>
        ))}
        {hasConflictFiles && (
          <>
            <ConflictPaths title="Working tree conflicts" files={working} />
            <ConflictPaths title="Predicted conflicts" files={predicted} />
          </>
        )}
      </div>

      {attached && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 14, borderRadius: 12, background: C.terminal, border: `1px solid ${CARD_BORDER}` }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ padding: '2px 8px', borderRadius: 20, background: 'oklch(0.78 0.09 160 / 0.14)', color: C.green, fontSize: 11, fontWeight: 500 }}>
                {attached.isDraft ? 'Draft' : 'Open'}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.faint }}>#{attached.number}</span>
            </div>
            <div title={`${branch} → ${attached.base ?? base}`} style={{ fontSize: 11.5, color: C.faint, ...ELLIPSIS }}>
              {branch} → {attached.base ?? base}
            </div>
          </div>

          {checks && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 12, borderTop: `1px solid ${SOFT_BORDER}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 7, height: 7, flex: 'none', borderRadius: '50%', background: checksDot(checks.state) }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 500 }}>{checksSummaryLabel(checks)}</span>
              </div>
              <CheckRows checks={checks.checks} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <StrategyMenu value={mergeStrategy} base={attached.base ?? base} onChange={onMergeStrategy} />
            <HoldButton
              label={mergeLabel}
              busyLabel="Merging…"
              busy={gitAction === 'merge'}
              disabled={!canMerge}
              title={mergeReason ?? `Hold to ${mergeStrategy} merge pull request #${attached.number}`}
              onConfirm={() => {
                if (!mergeStrategy) return
                onMergePr(mergeStrategy)
              }}
              style={{ height: 32, padding: 0, borderRadius: 7, fontSize: 12.5, fontWeight: 600, opacity: canMerge || gitAction === 'merge' ? 1 : 0.35 }}
              primary
            />
          </div>

          {attached.url && (
            <button
              type="button"
              className="bf-focus bf-hover-fill"
              title={`Open pull request #${attached.number} on GitHub`}
              onClick={() => window.open(attached.url, '_blank', 'noopener,noreferrer')}
              style={{ padding: '7px 0', textAlign: 'center', borderRadius: 7, background: C.panel, border: `1px solid ${SOFT_BORDER}`, color: C.text, font: 'inherit', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}
            >
              Open on GitHub
            </button>
          )}
        </div>
      )}

      {!attached && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 18 }}>
              <span style={{ flex: 1, fontSize: 12, color: C.textMuted }}>Title</span>
            </div>
            <input
              className="bf-input bf-focus"
              value={prDraft.title}
              onChange={(event) => onPrTitle(event.target.value)}
              placeholder="Defaults to the latest commit"
              aria-label="Pull request title"
              style={fieldBox}
            />
          </div>
          <Field label="Description" htmlFor="pr-description">
            <textarea
              id="pr-description"
              className="bf-input bf-focus"
              value={prDraft.description}
              onChange={(event) => onPrDescription(event.target.value)}
              rows={7}
              placeholder="Optional"
              aria-label="Pull request description"
              spellCheck={false}
              style={{ ...fieldBox, padding: '9px 10px', fontSize: 12.5, lineHeight: 1.55, resize: 'vertical' }}
            />
          </Field>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <AiButton
              busy={gitAction === 'generatePr'}
              disabled={!canGeneratePr}
              title={!base ? 'Choose a base branch before generating.' : gitAction ? 'Wait for the current Git action to finish' : `Generate with ${aiSelectionLabel(provider, model)}`}
              onClick={() => onPreparePr(base)}
              style={{ width: '100%', padding: '8px 10px' }}
            />
            <HoldButton
              label="Create pull request"
              busyLabel="Creating pull request…"
              busy={gitAction === 'pr'}
              disabled={!canCreatePr}
              title={prReason ?? 'Hold to create a pull request on GitHub'}
              onConfirm={() => onCreatePr(base, prDraft.title, prDraft.description)}
              style={{ flex: 'none', width: '100%', height: 'auto', padding: '9px 0', borderRadius: 8, fontSize: 12.5, fontWeight: 600 }}
              primary
            />
            {prReason && !canCreatePr && !gitAction && (
                <span style={{ fontSize: 11.5, color: C.faint, lineHeight: 1.45 }}>{prReason}</span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function HooksTab({ hooks }: { hooks: GitHookInfo[] | null }) {
  const list = hooks ?? []
  const blocking = new Map<string, string>()
  for (const kind of ['commit', 'push'] as const) {
    for (const hook of activeHooks(list, kind)) {
      blocking.set(hook.name, [...(blocking.get(hook.name)?.split(' & ') ?? []), kind].join(' & '))
    }
  }
  const groups = [
    { title: 'BLOCKING', rows: list.filter((hook) => blocking.has(hook.name)) },
    { title: 'OTHER', rows: list.filter((hook) => !blocking.has(hook.name)) }
  ].filter((group) => group.rows.length)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <span style={{ fontSize: 11.5, color: C.faint, lineHeight: 1.45 }}>
        {!hooks
          ? 'Reading hooks…'
          : list.length
            ? 'Hooks installed in .git/hooks. Farol hands the output of a failing hook to Chat.'
            : 'No hooks installed in this repository.'}
      </span>
      {groups.map((group) => (
        <SettingsGroup key={group.title} title={group.title}>
          {group.rows.map((hook, index) => (
            <div
              key={hook.name}
              title={hook.path}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', borderBottom: index === group.rows.length - 1 ? 'none' : `1px solid ${SOFT_BORDER}` }}
            >
              <span style={{ width: 7, height: 7, flex: 'none', borderRadius: '50%', background: hook.enabled ? C.green : 'transparent', border: hook.enabled ? 'none' : `1px solid ${C.fainter}` }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: MONO, fontSize: 12.5, color: hook.enabled ? C.text : C.faint }}>{hook.name}</div>
                {hook.enabled && blocking.has(hook.name) && (
                  <div style={{ fontSize: 11, color: BLOCKS, marginTop: 3 }}>Can block {blocking.get(hook.name)}</div>
                )}
              </div>
              {!hook.enabled && <span style={{ fontSize: 11, color: C.faint, flex: 'none' }}>disabled</span>}
            </div>
          ))}
        </SettingsGroup>
      ))}
    </div>
  )
}

function LogTab({ log }: { log: GitLogEntry[] }) {
  const entries = [...log].reverse()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span style={{ fontSize: 11.5, color: C.faint }}>Git commands and hook runs, newest first.</span>
      <div role="log" aria-live="polite" style={{ borderRadius: 9, background: WELL, border: `1px solid ${SOFT_BORDER}`, fontFamily: MONO, fontSize: 11, lineHeight: 1.6 }}>
        {!entries.length && <div style={{ padding: '14px 12px', color: C.faint }}>Nothing yet.</div>}
        {entries.map((entry, index) => (
          <div key={entry.id} style={{ padding: '8px 12px', borderBottom: index === entries.length - 1 ? 'none' : '1px solid oklch(1 0 0 / 0.05)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ flex: 'none', color: C.fainter }}>{entry.time}</span>
              <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word', color: !entry.ok ? C.red : entry.action === 'Hooks' ? BLOCKS : C.textSoft }}>{entry.action}</span>
            </div>
            {entry.message && (
              <div style={{ paddingLeft: 60, color: C.faint, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{entry.message}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

const TABS = [
  { value: 'pr', label: 'Pull request' },
  { value: 'hooks', label: 'Hooks' },
  { value: 'log', label: 'Log' }
] as const
type Tab = (typeof TABS)[number]['value']

export default function GitPane({
  branch,
  branches,
  remotes,
  provider,
  model,
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
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy | ''>('squash')
  const [tab, setTab] = useState<Tab>('pr')
  useEscapeClose(open, onClose)
  useFocusTrap(open, dialogRef)
  const aiModel = normalizeModel(model)

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
  const ahead = status?.ahead ?? 0

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Source Control"
      tabIndex={-1}
      style={{ position: 'fixed', inset: 0, zIndex: 90, display: 'flex', flexDirection: 'column', background: BG, color: C.text, fontFamily: UI, fontSize: 13, overflow: 'hidden' }}
    >
      <header style={{ height: 52, flex: 'none', display: 'flex', alignItems: 'center', gap: 18, padding: '0 16px 0 18px', borderBottom: `1px solid ${HAIR}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>Source Control</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, padding: '4px 9px', borderRadius: 7, background: C.sidebar, border: `1px solid ${HAIR}`, fontFamily: MONO, fontSize: 11.5 }}>
            <BranchIcon size={11} color={C.textMuted} />
            <span title={branch} style={{ maxWidth: 240, ...ELLIPSIS }}>{branch}</span>
            {base && (
              <>
                <span style={{ color: C.fainter }}>→</span>
                <span title={base} style={{ maxWidth: 160, color: C.textMuted, ...ELLIPSIS }}>{base}</span>
              </>
            )}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        {loading && <span style={{ fontSize: 12, color: C.faint }}>Updating…</span>}
        {status && (
          <span style={{ fontSize: 12, color: C.faint }}>{ahead ? `${ahead} ahead of origin` : 'Up to date'}</span>
        )}
        <button
          type="button"
          className="bf-focus bf-icon-btn"
          disabled={loading}
          onClick={refresh}
          title={refreshError ?? 'Refresh status and GitHub checks'}
          aria-label="Refresh"
          style={{ width: 28, height: 28, border: 'none', borderRadius: 7, display: 'grid', placeItems: 'center', background: 'transparent', color: C.textMuted, cursor: loading ? 'default' : 'pointer' }}
        >
          <RefreshIcon size={13} />
        </button>
        <button
          type="button"
          className="bf-focus bf-hover-fill"
          autoFocus
          onClick={onClose}
          style={{ padding: '6px 14px', borderRadius: 7, background: C.panel, border: `1px solid ${SOFT_BORDER}`, color: C.text, font: 'inherit', fontSize: 12.5, fontWeight: 500, cursor: 'pointer' }}
        >
          Done
        </button>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <main style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          <div style={{ maxWidth: 700, margin: '0 auto', padding: '36px 32px 64px', display: 'flex', flexDirection: 'column', gap: 32 }}>
            <ChangesSection status={status} selectedFiles={selectedFiles} onSelected={setFileSelected} onSelectAll={selectAllFiles} />
            <CommitSection
              provider={provider}
              model={aiModel}
              draft={draft}
              selectedCount={selectedFiles.length}
              gitAction={gitAction}
              commitReason={commitReason}
              pushReason={pushReason}
              ahead={ahead}
              onDraftMessage={setDraftMessage}
              onPrepare={() => void prepareCommit(provider, aiModel)}
              onCommit={confirmCommit}
              onPush={push}
            />
            <HistorySection commits={commits} unpushed={ahead} />
          </div>
        </main>

        <aside style={{ width: 360, flex: 'none', display: 'flex', flexDirection: 'column', background: C.sidebar, borderLeft: `1px solid ${HAIR}` }}>
          <div style={{ flex: 'none', padding: '14px 16px 0' }}>
            <Seg label="Source Control panel" options={TABS} value={tab} onChange={setTab} />
          </div>
          <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflowX: 'hidden', overflowY: 'auto', padding: '20px 16px 24px' }}>
            {tab === 'pr' && (
              <PullRequestTab
                branch={branch}
                status={baseStatus}
                github={github}
                gitAction={gitAction}
                baseOptions={baseOptions}
                base={base}
                prDraft={prDraft}
                provider={provider}
                model={aiModel}
                mergeStrategy={mergeStrategy}
                onBase={setPrBase}
                onPrTitle={setPrTitle}
                onPrDescription={setPrDescription}
                onPreparePr={(nextBase) => void preparePr(nextBase, provider, aiModel)}
                onMergeStrategy={setMergeStrategy}
                onFixConflicts={resolveConflicts}
                onCreatePr={createPr}
                onMergePr={(strategy) => {
                  void mergePr(strategy)
                  setMergeStrategy('squash')
                }}
              />
            )}
            {tab === 'hooks' && <HooksTab hooks={hooks} />}
            {tab === 'log' && <LogTab log={log} />}
          </div>
        </aside>
      </div>
    </div>,
    document.body
  )
}
