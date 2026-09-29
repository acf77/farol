import { C } from '../theme'
import { Button } from './controls'
import farolMark from '../assets/farol-mark.png'

export default function EmptyState({ onOpenProject }: { onOpenProject: () => void }) {
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
          Open a folder to start a shell and run pipelines.
        </div>
        <Button variant="primary" size="md" onClick={onOpenProject} style={{ marginTop: 4 }}>
          Open Project…
        </Button>
      </div>
    </div>
  )
}
