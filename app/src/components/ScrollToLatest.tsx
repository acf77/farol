import { C } from '../theme'
import { ArrowDownIcon } from './icons'

export default function ScrollToLatest({ visible, onClick }: { visible: boolean; onClick: () => void }) {
  if (!visible) return null
  return (
    <button type="button" className="bf-focus" onClick={onClick} title="Jump to latest" aria-label="Jump to latest"
      style={{ position: 'absolute', right: 18, bottom: 14, zIndex: 5, width: 30, height: 30, padding: 0,
        display: 'grid', placeItems: 'center', borderRadius: '50%', border: `1px solid ${C.border}`,
        background: C.panel, color: C.text, boxShadow: '0 5px 16px rgba(0,0,0,0.35)', cursor: 'pointer' }}>
      <ArrowDownIcon size={16} />
    </button>
  )
}
