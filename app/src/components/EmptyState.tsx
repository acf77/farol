import { C } from '../theme'
import { Button } from './controls'
import { OPEN_MACHINE_EVENT, machineName, useMachine } from './MachineControls'
import farolMark from '../assets/farol-mark.png'

export default function EmptyState({ onOpenProject }: { onOpenProject: () => void }) {
  const { status } = useMachine()
  const remote = status?.config ? machineName(status.config) : null
  return (
    <div
      style={{
        flex: 1,
        display: 'grid',
        placeItems: 'center',
        background: 'transparent'
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <img
          src={farolMark}
          alt=""
          width={72}
          height={72}
          draggable={false}
          style={{ borderRadius: 12, display: 'block' }}
        />
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.35px', color: C.text }}>
          No Project Open
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: C.textMuted, maxWidth: 280, textAlign: 'center' }}>
          {remote
            ? `Open a folder on ${remote} to start a shell and run pipelines there.`
            : 'Open a folder to start a shell and run pipelines.'}
        </div>
        <Button variant="primary" size="md" onClick={onOpenProject} style={{ marginTop: 4 }}>
          Open Project…
        </Button>
        <Button variant="ghost" size="md" onClick={() => window.dispatchEvent(new Event(OPEN_MACHINE_EVENT))}>
          {remote ? `Remote machine: ${remote}` : 'Work on a remote machine…'}
        </Button>
      </div>
    </div>
  )
}
