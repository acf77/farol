import { C } from '../theme'
import { Button } from './controls'

export default function EmptyState({ onOpenProject }: { liquid?: boolean; onOpenProject: () => void }) {
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
        <svg width="34" height="34" viewBox="0 0 16 16" stroke={C.purple} strokeWidth={1.15} fill="none">
          <path d="M8 1v14M1 8h14M3.05 3.05l9.9 9.9M12.95 3.05l-9.9 9.9" />
        </svg>
        <div style={{ fontSize: 17, fontWeight: 500, letterSpacing: '-0.2px', color: C.textStrong }}>
          No Project Open
        </div>
        <div style={{ fontSize: 13, color: C.dim }}>
          Open a folder to start a shell and run pipelines.
        </div>
        <Button variant="primary" size="md" onClick={onOpenProject} style={{ marginTop: 4 }}>
          Open Project…
        </Button>
      </div>
    </div>
  )
}
