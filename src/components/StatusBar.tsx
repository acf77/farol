import { useEffect, useState } from 'react'
import { AI_LABELS } from '@shared/ai'
import type { AiProvider } from '@shared/types'
import { AI_PROVIDERS } from '@shared/types'
import { C, MONO } from '../theme'
import { CheckIcon, ChevronDown, Spinner } from './icons'

interface Props {
  branch: string
  running: boolean
  runningLabel: string
  processCount: number
  agent: AiProvider
  onBranch: () => void
  onAgentChange: (agent: AiProvider) => void
  onStop?: () => void
}

/** Bottom strip: branch, run counts, run state and the configured agent. */
export default function StatusBar({
  branch,
  running,
  runningLabel,
  processCount,
  agent,
  onBranch,
  onAgentChange,
  onStop
}: Props) {
  const [agentOpen, setAgentOpen] = useState(false)

  useEffect(() => {
    if (!agentOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAgentOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [agentOpen])

  return (
    <div
      style={{
        flex: 'none',
        height: 34,
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        gap: 16,
        padding: '0 16px',
        borderTop: '1px solid #1a202b',
        background: '#0b0e14',
        position: 'relative'
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

      <div style={{ position: 'relative', justifySelf: 'center' }}>
        <div
          className="bf-status-item"
          onClick={() => setAgentOpen((v) => !v)}
          title="Change agent"
          style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#aeb6c3', cursor: 'pointer' }}
        >
          <span style={{ fontSize: 11.5 }}>Agent: {AI_LABELS[agent]}</span>
          <ChevronDown size={11} />
        </div>
        {agentOpen && (
          <>
            <div
              aria-hidden
              onClick={() => setAgentOpen(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 40 }}
            />
            <div
              role="menu"
              aria-label="Agent"
              style={{
                position: 'absolute',
                left: '50%',
                bottom: 28,
                transform: 'translateX(-50%)',
                zIndex: 50,
                width: 168,
                background: '#111621',
                border: `1px solid ${C.cardBorder}`,
                borderRadius: 10,
                boxShadow: '0 14px 36px rgba(0,0,0,0.5)',
                padding: 4
              }}
            >
              {AI_PROVIDERS.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="menuitem"
                  className="bf-focus bf-menu-item"
                  onClick={() => {
                    onAgentChange(p)
                    setAgentOpen(false)
                  }}
                  style={{
                    display: 'flex',
                    width: '100%',
                    justifyContent: 'space-between',
                    border: 'none',
                    background: 'transparent',
                    color: p === agent ? C.textStrong : C.textMuted,
                    cursor: 'pointer'
                  }}
                >
                  <span>{AI_LABELS[p]}</span>
                  {p === agent && <CheckIcon size={12} />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div
        style={{
          justifySelf: 'end',
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
