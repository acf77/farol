import { C, MONO } from '../theme'
import { Spinner } from './icons'

interface Props {
  branch: string
  running: boolean
  runningLabel: string
  processCount: number
  onBranch: () => void
  onStop?: () => void
}

/** Bottom strip: branch, process count, and run state. */
export default function StatusBar({
  branch,
  running,
  runningLabel,
  processCount,
  onBranch,
  onStop
}: Props) {
  return (
    <div
      style={{
        flex: 'none',
        height: 34,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '0 16px',
        borderTop: '1px solid #1a202b',
        background: '#0b0e14'
      }}
    >
      <div
        className="bf-status-item"
        onClick={onBranch}
        title="Open branch as project"
        style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#aeb6c3', cursor: 'pointer' }}
      >
        {branch && <span style={{ fontSize: 11.5, fontFamily: MONO }}>{branch}</span>}
        {branch && <span style={{ color: '#5c6577' }}>·</span>}
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: processCount ? C.green : C.fainter }} />
        <span style={{ fontSize: 11.5 }}>
          {processCount} {processCount === 1 ? 'process' : 'processes'}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          color: running ? '#c3cad6' : '#7f889a'
        }}
      >
        {running && onStop && (
          <button
            type="button"
            className="bf-focus"
            onClick={onStop}
            title="Stop pipeline"
            style={{
              height: 22,
              padding: '0 9px',
              borderRadius: 6,
              border: '1px solid #3a2830',
              background: 'rgba(224, 123, 123, 0.12)',
              color: C.red,
              fontSize: 11.5,
              fontWeight: 500,
              cursor: 'pointer'
            }}
          >
            Stop
          </button>
        )}
        {running ? <Spinner /> : <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.fainter }} />}
        <span style={{ fontSize: 11.5 }}>{runningLabel}</span>
      </div>
    </div>
  )
}
