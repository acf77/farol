import { useEffect, useRef, useState } from 'react'
import { C, MONO } from '../theme'
import { Button } from './controls'

export interface RemoveResult {
  ok: boolean
  message: string
  /** Git refused because the folder has uncommitted changes. */
  dirty?: boolean
}

/** Asks what to do when a chat row on the left is closed: keep the folder or delete it. */
export default function CloseProjectDialog({
  branch,
  path,
  canDelete,
  busy,
  onCancel,
  onClose,
  onDelete
}: {
  branch: string
  path: string
  /** False for the main checkout, which cannot be deleted. */
  canDelete: boolean
  /** An agent is still working in this checkout. */
  busy: boolean
  onCancel: () => void
  onClose: () => void
  onDelete: (force: boolean) => Promise<RemoveResult>
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<RemoveResult | null>(null)

  useEffect(() => {
    const previousFocus = document.activeElement
    cardRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true })
      }
    }
  }, [])

  const remove = async (force: boolean): Promise<void> => {
    setPending(true)
    const res = await onDelete(force).catch(
      (e: unknown): RemoveResult => ({ ok: false, message: e instanceof Error ? e.message : String(e) })
    )
    if (!res.ok) {
      setFailure(res)
      setPending(false)
    }
  }

  const keepFocusInside = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (!pending) onCancel()
      return
    }
    if (e.key !== 'Tab') return
    const buttons = cardRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)')
    if (!buttons?.length) return
    const first = buttons[0]!
    const last = buttons[buttons.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="close-project-title"
      aria-describedby="close-project-desc"
      onKeyDown={keepFocusInside}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pending) onCancel()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        boxSizing: 'border-box',
        background: 'rgba(12, 12, 10, 0.55)',
        animation: 'bfOverlayIn 120ms ease-out'
      }}
    >
      <div
        ref={cardRef}
        style={{
          width: '100%',
          maxWidth: 380,
          boxSizing: 'border-box',
          padding: '16px 18px',
          borderRadius: 12,
          background: C.sidebar,
          border: `1px solid ${C.border}`,
          boxShadow: '0 18px 48px rgba(0,0,0,0.55)',
          animation: 'bfOverlayCardIn 140ms ease-out'
        }}
      >
        <div id="close-project-title" style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
          Close <span style={{ fontFamily: MONO }}>{branch}</span>?
        </div>
        <div id="close-project-desc" style={{ fontSize: 12, lineHeight: 1.45, color: C.textMuted, marginTop: 6 }}>
          Close hides this chat and keeps the folder.{' '}
          {canDelete
            ? `Delete also removes the worktree folder ${path}. The git branch stays.`
            : 'The main checkout cannot be deleted.'}
          {busy && ' An agent is working here. Both choices stop it.'}
        </div>
        {failure && (
          <div role="alert" style={{ fontSize: 12, lineHeight: 1.45, color: C.red, marginTop: 8 }}>
            {failure.dirty
              ? 'The folder has uncommitted changes. Force delete discards them.'
              : failure.message}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={onClose}>
            Close
          </Button>
          <Button
            variant="danger"
            disabled={pending || !canDelete}
            onClick={() => void remove(!!failure?.dirty)}
            style={{ background: 'rgba(255, 98, 90,0.16)' }}
          >
            {failure?.dirty ? 'Force delete' : 'Delete'}
          </Button>
        </div>
      </div>
    </div>
  )
}
