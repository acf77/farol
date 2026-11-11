import { useEffect, useId, useRef, useState } from 'react'
import type { MachineConfig, MachineStatus } from '@shared/machine'
import { C, MONO } from '../theme'
import { Button } from './controls'

/**
 * The Remote machine UI: the connect form (in Settings and in a dialog from the
 * empty state), the folder prompt that replaces the native picker while on a
 * Remote machine, and the header badge that says which machine this is.
 */

/** Ask `MachineHost` to show the connect dialog (from places without Settings, like the empty state). */
export const OPEN_MACHINE_EVENT = 'farol:open-machine'

const STATE_LABEL: Record<MachineStatus['state'], string> = {
  off: 'This computer',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  error: 'Could not connect'
}

const STATE_COLOR: Record<MachineStatus['state'], string> = {
  off: C.faint,
  connecting: C.faint,
  connected: C.green,
  reconnecting: C.faint,
  error: C.red
}

export function machineName(config: MachineConfig): string {
  return config.user ? `${config.user}@${config.host}` : config.host
}

/** Live status, and the last machine used (to pre-fill the form). */
export function useMachine(): { status: MachineStatus | null; saved: MachineConfig | null } {
  const api = window.farol
  const [status, setStatus] = useState<MachineStatus | null>(null)
  const [saved, setSaved] = useState<MachineConfig | null>(null)
  useEffect(() => {
    let live = true
    void api.machine
      .status()
      .then((res) => {
        if (!live) return
        setStatus(res.status)
        setSaved(res.saved)
      })
      .catch(() => undefined)
    const off = api.machine.onStatus((next) => live && setStatus(next))
    return () => {
      live = false
      off()
    }
  }, [api.machine])
  return { status, saved }
}

const field: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 30,
  padding: '0 10px',
  borderRadius: 7,
  border: `1px solid ${C.border}`,
  background: C.app,
  color: C.text,
  fontSize: 12,
  outline: 'none',
  userSelect: 'text'
}

const ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px' }
const LABEL: React.CSSProperties = { width: 72, flex: 'none', fontSize: 13 }

/** Host, user, port and key — the only things Farol needs to reach the machine. */
export function MachineForm({ onDone }: { onDone?: () => void }) {
  const api = window.farol
  const { status, saved } = useMachine()
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState('')
  const [identityFile, setIdentityFile] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const filled = useRef(false)

  useEffect(() => {
    const fill = status?.config ?? saved
    if (filled.current || !status || !fill) return
    filled.current = true
    setHost(fill.host)
    setUser(fill.user ?? '')
    setPort(fill.port ? String(fill.port) : '')
    setIdentityFile(fill.identityFile ?? '')
  }, [status, saved])

  const inUse = !!status?.config
  const locked = busy || inUse

  const connect = (e?: React.FormEvent): void => {
    e?.preventDefault()
    if (locked || !host.trim()) return
    setBusy(true)
    setError(null)
    void api.machine
      .connect({ host, user, identityFile, ...(port.trim() ? { port: Number(port) } : {}) })
      .then((res) => {
        // On success the window reloads onto the Remote machine.
        if (res.ok) onDone?.()
        else setError(res.error)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  const message = error ?? (busy ? (status?.message ?? 'Connecting…') : status?.message)

  return (
    <form onSubmit={connect} style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={ROW}>
        <span style={LABEL}>Status</span>
        <span style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 12, color: C.textMuted }}>
          <span style={{ color: status ? STATE_COLOR[status.state] : C.faint }}>●</span>{' '}
          {status ? STATE_LABEL[status.state] : '…'}
          {status?.config ? ` · ${machineName(status.config)}` : ''}
        </span>
      </div>
      <div style={ROW}>
        <span style={LABEL}>Host</span>
        <input
          className="bf-input bf-focus"
          aria-label="Host"
          placeholder="100.101.102.103 or devbox — Tailscale IP or MagicDNS name"
          autoFocus={!inUse}
          value={host}
          disabled={locked}
          onChange={(e) => setHost(e.target.value)}
          style={field}
        />
      </div>
      <div style={ROW}>
        <span style={LABEL}>User</span>
        <input
          className="bf-input bf-focus"
          aria-label="User"
          placeholder="Optional — ~/.ssh/config or your user name"
          value={user}
          disabled={locked}
          onChange={(e) => setUser(e.target.value)}
          style={field}
        />
        <input
          className="bf-input bf-focus"
          aria-label="Port"
          placeholder="22"
          inputMode="numeric"
          value={port}
          disabled={locked}
          onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
          style={{ ...field, flex: 'none', width: 64 }}
        />
      </div>
      <div style={ROW}>
        <span style={LABEL}>SSH key</span>
        <input
          className="bf-input bf-focus"
          aria-label="SSH key"
          placeholder="Optional — SSH agent, ~/.ssh/config, or Tailscale SSH"
          value={identityFile}
          disabled={locked}
          onChange={(e) => setIdentityFile(e.target.value)}
          style={{ ...field, fontFamily: MONO }}
        />
        <Button
          type="button"
          disabled={locked}
          onClick={() => void api.machine.pickKey().then((file) => file && setIdentityFile(file))}
        >
          Choose…
        </Button>
      </div>
      <div style={{ ...ROW, justifyContent: 'flex-end', gap: 8, padding: '8px 10px 10px 16px' }}>
        <span
          role={error ? 'alert' : 'status'}
          style={{ flex: 1, minWidth: 0, fontSize: 11.5, lineHeight: 1.45, color: error ? C.red : C.faint, textWrap: 'pretty' }}
        >
          {message}
        </span>
        {status?.authUrl && (
          <Button type="button" variant="ghost" onClick={() => void api.machine.openAuthUrl(status.authUrl!)}>
            Approve login
          </Button>
        )}
        {inUse ? (
          <Button type="button" disabled={busy} onClick={() => void api.machine.disconnect()}>
            Use this computer
          </Button>
        ) : (
          <Button type="submit" variant="primary" disabled={busy || !host.trim()}>
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        )}
      </div>
    </form>
  )
}

function Modal({
  title,
  description,
  onClose,
  children
}: {
  title: string
  description: string
  onClose: () => void
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className="bf-machine-dialog bf-page-overlay"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        maxWidth: 'none',
        maxHeight: 'none',
        margin: 0,
        padding: 16,
        border: 'none',
        boxSizing: 'border-box',
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(0,0,0,0.45)',
        color: C.text,
        font: 'inherit'
      }}
    >
      <style>{`
        .bf-machine-dialog:not([open]) { display: none !important; }
        .bf-machine-dialog::backdrop { background: transparent; }
      `}</style>
      <div
        style={{
          width: 520,
          maxWidth: '100%',
          borderRadius: 10,
          background: C.panel,
          border: '1px solid #3E3E3A',
          boxShadow: '0 18px 48px rgba(0,0,0,0.55)',
          overflowWrap: 'anywhere'
        }}
      >
        <div style={{ padding: '16px 16px 6px' }}>
          <div id={titleId} style={{ fontSize: 13, fontWeight: 600 }}>
            {title}
          </div>
          <div style={{ fontSize: 11.5, color: C.textMuted, lineHeight: 1.45, marginTop: 4, textWrap: 'pretty' }}>
            {description}
          </div>
        </div>
        {children}
      </div>
    </dialog>
  )
}

/** Open Project while on a Remote machine: type a folder path there. */
function MachineProjectDialog({ status, onClose }: { status: MachineStatus; onClose: () => void }) {
  const api = window.farol
  const [dir, setDir] = useState('~/')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = status.config ? machineName(status.config) : 'the remote machine'

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (busy || !dir.trim()) return
    setBusy(true)
    setError(null)
    void api.machine
      .openProject(dir)
      .then((res) => (res.ok ? onClose() : setError(res.error)))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <Modal
      title={`Open project on ${name}`}
      description={`A folder on ${name}, such as ~/code/my-app. ~ is your home folder there${status.home ? ` (${status.home})` : ''}.`}
      onClose={onClose}
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 16px 16px' }}>
        <input
          className="bf-input bf-focus"
          aria-label="Folder on the remote machine"
          autoFocus
          value={dir}
          disabled={busy}
          onChange={(e) => setDir(e.target.value)}
          style={{ ...field, flex: 'none', fontFamily: MONO }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span role="alert" style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: C.red }}>
            {error}
          </span>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !dir.trim()}>
            {busy ? 'Opening…' : 'Open'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** Mounted once at the top of the app: answers Open Project on a Remote machine, and the empty state's connect button. */
export function MachineHost() {
  const api = window.farol
  const { status } = useMachine()
  const [picking, setPicking] = useState(false)
  const [connecting, setConnecting] = useState(false)

  useEffect(() => api.machine.onPickProject(() => setPicking(true)), [api.machine])
  useEffect(() => {
    const open = (): void => setConnecting(true)
    window.addEventListener(OPEN_MACHINE_EVENT, open)
    return () => window.removeEventListener(OPEN_MACHINE_EVENT, open)
  }, [])

  return (
    <>
      {picking && status?.config && <MachineProjectDialog status={status} onClose={() => setPicking(false)} />}
      {connecting && (
        <Modal
          title="Remote machine"
          description="Work on a Linux machine over SSH, such as one on your tailnet. Farol sets it up the first time: its own Node.js and server in ~/.farol-server, plus git if it is missing (that needs root or passwordless sudo). Sign in to the agent CLIs you use on that machine."
          onClose={() => setConnecting(false)}
        >
          <MachineForm onDone={() => setConnecting(false)} />
        </Modal>
      )}
    </>
  )
}

/** Which machine this window is working on; only shown while that is not this computer. */
export function MachineBadge() {
  const { status } = useMachine()
  if (!status?.config) return null
  return (
    <button
      type="button"
      className="bf-focus bf-hover-fill"
      title={status.message ?? STATE_LABEL[status.state]}
      onClick={() => window.dispatchEvent(new Event(OPEN_MACHINE_EVENT))}
      style={{
        WebkitAppRegion: 'no-drag',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 24,
        padding: '0 8px',
        borderRadius: 6,
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.textMuted,
        fontFamily: MONO,
        fontSize: 11,
        cursor: 'pointer',
        maxWidth: 220
      } as React.CSSProperties}
    >
      <span style={{ color: STATE_COLOR[status.state] }}>●</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status.config.host}</span>
    </button>
  )
}
