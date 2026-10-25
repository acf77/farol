import { useMemo, useState } from 'react'
import type { GitStatus, GitStatusFile } from '@shared/types'
import { C, MONO, ELLIPSIS } from '../theme'
import { EditIcon } from './icons'
import { SideCard } from './side-panel'

const VISIBLE = 5

/** One entry per path: a file staged and edited again counts once, with its lines summed. */
function changedFiles(status: GitStatus | null): GitStatusFile[] {
  const byPath = new Map<string, GitStatusFile>()
  for (const file of [...(status?.staged ?? []), ...(status?.unstaged ?? []), ...(status?.untracked ?? [])]) {
    const seen = byPath.get(file.path)
    byPath.set(file.path, seen ? { ...seen, added: (seen.added ?? 0) + (file.added ?? 0), removed: (seen.removed ?? 0) + (file.removed ?? 0) } : file)
  }
  return [...byPath.values()]
}

function FileRow({ file, onOpen }: { file: GitStatusFile; onOpen: (path: string) => void }) {
  const parts = file.path.split('/')
  const created = file.kind === 'added' || file.kind === 'untracked'
  return (
    <button
      type="button"
      title={file.path}
      disabled={file.kind === 'deleted'}
      className="bf-focus bf-row"
      onClick={() => onOpen(file.path)}
      style={{ display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', padding: '6px 0', border: 0, background: 'transparent', fontFamily: 'inherit', fontSize: 13, textAlign: 'left', cursor: file.kind === 'deleted' ? 'default' : 'pointer' }}
    >
      <span aria-hidden style={{ width: 14, flex: 'none', alignSelf: 'center', display: 'grid', placeItems: 'center', color: C.textMuted }}>
        {created ? '+' : <EditIcon size={12} />}
      </span>
      <span style={{ flex: 'none', color: file.kind === 'deleted' ? C.faint : C.textSoft, textDecoration: file.kind === 'deleted' ? 'line-through' : 'none' }}>
        {parts.at(-1)}
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: C.faint, ...ELLIPSIS }}>{parts.length > 1 ? parts.at(-2) : ''}</span>
    </button>
  )
}

/** The branch's uncommitted changes: a count, line totals and the first few files. */
export default function FilesChanged({ status, onOpen }: { status: GitStatus | null; onOpen: (path: string) => void }) {
  const [all, setAll] = useState(false)
  const files = useMemo(() => changedFiles(status), [status])
  if (!files.length) return null
  const added = files.reduce((sum, f) => sum + (f.added ?? 0), 0)
  const removed = files.reduce((sum, f) => sum + (f.removed ?? 0), 0)
  const shown = all ? files : files.slice(0, VISIBLE)
  return (
    <SideCard label="Files changed">
    <div style={{ padding: '14px 8px 12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', color: C.faint }}>FILES CHANGED</span>
        <span style={{ padding: '1px 7px', borderRadius: 20, background: 'oklch(1 0 0 / 0.08)', fontSize: 11, fontWeight: 500, color: C.textSoft }}>
          {files.length}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: MONO, fontSize: 11, color: C.textMuted }}>+{added}</span>
        <span style={{ fontFamily: MONO, fontSize: 11, color: C.textMuted }}>−{removed}</span>
      </div>
      {shown.map((file) => (
        <FileRow key={file.path} file={file} onOpen={onOpen} />
      ))}
      {files.length > VISIBLE && (
        <button
          type="button"
          className="bf-focus bf-icon-btn"
          onClick={() => setAll((v) => !v)}
          style={{ marginTop: 4, marginLeft: 22, padding: '3px 0', border: 0, background: 'transparent', fontFamily: 'inherit', fontSize: 12.5, color: C.faint, cursor: 'pointer' }}
        >
          {all ? 'Show less' : `Show ${files.length - VISIBLE} more`}
        </button>
      )}
    </div>
    </SideCard>
  )
}
