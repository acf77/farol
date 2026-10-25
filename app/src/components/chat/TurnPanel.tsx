import { useCallback, useEffect, useState } from 'react'
import type { RevertOutcome, TurnFile, TurnInfo } from '@shared/types'
import { C, ELLIPSIS, MONO } from '../../theme'
import { Button } from '../controls'

const api = window.farol
const PREVIEW_FILES = 12

type Preview = { files: TurnFile[]; fileCount: number } | { message: string }

/** `+a −r · n files` for a finished turn; what it is doing otherwise. */
export function turnStat(turn: TurnInfo): string {
  if (!turn.done) return 'running or interrupted'
  if (!turn.changed) return 'no file changes'
  const sum = (key: 'added' | 'removed'): number => turn.files.reduce((total, file) => total + (file[key] ?? 0), 0)
  const count = `${turn.fileCount} file${turn.fileCount === 1 ? '' : 's'}`
  return `+${sum('added')} −${sum('removed')} · ${count}`
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
export default function TurnPanel({ taskId, cwd, busy, onClose }: {
  taskId: string
  cwd: string
  busy: boolean
  onClose: () => void
}) {
  const [turns, setTurns] = useState<TurnInfo[]>([])
  const [open, setOpen] = useState<number | null>(null)
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

  return (
    <aside aria-label="Turn checkpoints" style={{ width: 300, flex: 'none', borderLeft: `1px solid ${C.hair}`, display: 'flex', flexDirection: 'column', minHeight: 0, background: C.app }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 12px 8px', gap: 8 }}>
        <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: C.text }}>Turns</span>
        <Button variant="ghost" onClick={onClose} aria-label="Close turns">Close</Button>
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
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        {turns.length === 0 && (
          <div style={{ padding: '8px 12px', fontSize: 12, color: C.faint }}>
            No checkpoints yet. Each Build message saves one when it starts and one when it ends.
          </div>
        )}
        {[...turns].reverse().map((turn) => (
          <div key={turn.turn} style={{ padding: '8px 12px', borderTop: `1px solid ${C.hair}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button type="button" className="bf-focus" aria-expanded={open === turn.turn}
              onClick={() => setOpen(open === turn.turn ? null : turn.turn)}
              style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ ...ELLIPSIS, fontSize: 12, color: C.text }} title={turn.prompt}>
                {turn.kind === 'revert' ? `Safety checkpoint · ${turn.prompt}` : `${turn.turn}. ${turn.prompt || 'Message'}`}
              </span>
              <span style={{ fontSize: 11, color: C.faint }}>
                {new Date(turn.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {turnStat(turn)}
              </span>
            </button>
            {open === turn.turn && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
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
      </div>
    </aside>
  )
}
