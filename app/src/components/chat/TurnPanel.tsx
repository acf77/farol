import { useCallback, useEffect, useState } from 'react'
import type { RevertOutcome, TurnFile, TurnInfo } from '@shared/types'
import { C, ELLIPSIS, MONO } from '../../theme'
import { Button } from '../controls'
import { CardTitle, SideCard } from '../side-panel'

const api = window.farol
const PREVIEW_FILES = 12
const VISIBLE = 5

type Preview = { files: TurnFile[]; fileCount: number } | { message: string }

/** `+a −r · n files` for a finished turn; what it is doing otherwise. */
export function turnStat(turn: TurnInfo): string {
  if (!turn.done) return 'running or interrupted'
  if (!turn.changed) return 'no file changes'
  return `${turnTotals(turn)} · ${turn.fileCount} file${turn.fileCount === 1 ? '' : 's'}`
}

/** `+a −r` for a finished turn with changes; blank otherwise. */
function turnTotals(turn: TurnInfo): string {
  if (!turn.done || !turn.changed) return ''
  const sum = (key: 'added' | 'removed'): number => turn.files.reduce((total, file) => total + (file[key] ?? 0), 0)
  return `+${sum('added')} −${sum('removed')}`
}

function FileRow({ file }: { file: TurnFile }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 11, fontFamily: MONO, color: C.textMuted }}>
      <span style={{ ...ELLIPSIS, flex: 1 }} title={file.path}>{file.path}</span>
      <span style={{ flex: 'none' }}>{file.added === null ? 'binary' : `+${file.added} −${file.removed}`}</span>
    </div>
  )
}

function RevertConfirm({ turn, preview, busy, working, onCancel, onConfirm }: {
  turn: number
  preview: Preview
  busy: boolean
  working: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const files = 'files' in preview ? preview.files : []
  const count = 'files' in preview ? preview.fileCount : 0
  return (
    <div role="alertdialog" aria-label={`Revert to before turn ${turn}`}
      style={{ margin: '0 12px 12px', padding: 12, borderRadius: 12, background: C.panel, border: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>Revert to before turn {turn}?</div>
      {'message' in preview ? (
        <div style={{ fontSize: 12, color: C.red }}>{preview.message}</div>
      ) : count === 0 ? (
        <div style={{ fontSize: 12, color: C.textMuted }}>The files already match. Nothing to revert.</div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: C.textMuted }}>{count} file{count === 1 ? '' : 's'} will change. Files created since then are removed.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {files.slice(0, PREVIEW_FILES).map((file) => <FileRow key={file.path} file={file} />)}
            {count > PREVIEW_FILES && <div style={{ fontSize: 11, color: C.faint }}>and {count - PREVIEW_FILES} more</div>}
          </div>
        </>
      )}
      <div style={{ fontSize: 11, color: C.faint, lineHeight: 1.5 }}>
        Files only. The agent still remembers the later turns: use Fresh start, or /rewind in Claude Code, to rewind its memory.
        Your branch and commits stay as they are. A safety checkpoint is saved first, so you can revert this revert.
      </div>
      {busy && <div style={{ fontSize: 11, color: C.yellow }}>The agent is working. Stop it, or wait, before you revert.</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={working}>Cancel</Button>
        <Button variant="danger" onClick={onConfirm} disabled={busy || working || !('files' in preview) || count === 0}>
          {working ? 'Reverting…' : 'Revert files'}
        </Button>
      </div>
    </div>
  )
}

/** The chat's per-turn checkpoints: what each turn changed, and a way back to before any of them. */
export default function TurnPanel({ taskId, cwd, busy }: { taskId: string; cwd: string; busy: boolean }) {
  const [turns, setTurns] = useState<TurnInfo[]>([])
  const [open, setOpen] = useState<number | null>(null)
  const [all, setAll] = useState(false)
  const [confirm, setConfirm] = useState<{ turn: number; preview: Preview } | null>(null)
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState<RevertOutcome | null>(null)

  const load = useCallback(() => {
    void api.agent.turns(taskId, cwd).then(setTurns, () => setTurns([]))
  }, [taskId, cwd])
  useEffect(() => {
    load()
    return api.agent.onEvent((event) => {
      if (event.kind === 'turns' && event.taskId === taskId) load()
    })
  }, [taskId, load])

  const askRevert = (turn: number): void => {
    setResult(null)
    setConfirm({ turn, preview: { files: [], fileCount: 0 } })
    void api.agent.revertPreview(taskId, turn, cwd).then((preview) => setConfirm({ turn, preview }))
  }
  const revert = (turn: number): void => {
    setWorking(true)
    void api.agent
      .revertTurn(taskId, turn, cwd)
      .then(setResult, (error) => setResult({ ok: false, message: String(error) }))
      .finally(() => {
        setWorking(false)
        setConfirm(null)
        load()
      })
  }

  if (!turns.length && !confirm && !result) return null
  const shown = (all ? turns : turns.slice(-VISIBLE)).slice().reverse()
  return (
    <SideCard label="Turn checkpoints">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 4px 16px' }}>
        <CardTitle title="TURNS" count={turns.length} />
      </div>
      {result && (
        <div role="status" style={{ margin: '0 12px 8px', fontSize: 12, color: result.ok ? C.green : C.red }}>
          {result.ok ? `Reverted ${result.fileCount} file${result.fileCount === 1 ? '' : 's'}.` : result.message}
        </div>
      )}
      {confirm && (
        <RevertConfirm turn={confirm.turn} preview={confirm.preview} busy={busy} working={working}
          onCancel={() => setConfirm(null)} onConfirm={() => revert(confirm.turn)} />
      )}
      <div style={{ display: 'flex', flexDirection: 'column', padding: '0 8px 12px 16px' }}>
        {shown.map((turn) => (
          <div key={turn.turn} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button type="button" className="bf-focus bf-row" aria-expanded={open === turn.turn}
              title={`${turn.prompt}\n${turnStat(turn)}`}
              onClick={() => setOpen(open === turn.turn ? null : turn.turn)}
              style={{ display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', padding: '6px 0', border: 0, background: 'transparent', fontFamily: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer' }}>
              <span style={{ flex: 1, minWidth: 0, color: C.textSoft, ...ELLIPSIS }}>
                {turn.kind === 'revert' ? `Safety · ${turn.prompt}` : `${turn.turn}. ${turn.prompt || 'Message'}`}
              </span>
              <span style={{ flex: 'none', fontSize: 11, fontFamily: MONO, color: C.faint }}>{turnTotals(turn)}</span>
            </button>
            {open === turn.turn && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 6 }}>
                {turn.files.slice(0, PREVIEW_FILES * 4).map((file) => <FileRow key={file.path} file={file} />)}
                {turn.fileCount > PREVIEW_FILES * 4 && <div style={{ fontSize: 11, color: C.faint }}>and {turn.fileCount - PREVIEW_FILES * 4} more</div>}
                {turn.skipped.length > 0 && (
                  <div style={{ fontSize: 11, color: C.yellow }} title={turn.skipped.join('\n')}>
                    {turn.skipped.length} large file{turn.skipped.length === 1 ? '' : 's'} not saved
                  </div>
                )}
                <div>
                  <Button variant="secondary" onClick={() => askRevert(turn.turn)} disabled={working}>
                    Revert to before this turn
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
        {turns.length > VISIBLE && (
          <button type="button" className="bf-focus bf-icon-btn" onClick={() => setAll((v) => !v)}
            style={{ marginTop: 4, padding: '3px 0', border: 0, background: 'transparent', fontFamily: 'inherit', fontSize: 12.5, color: C.faint, cursor: 'pointer', textAlign: 'left' }}>
            {all ? 'Show less' : `Show ${turns.length - VISIBLE} more`}
          </button>
        )}
      </div>
    </SideCard>
  )
}
