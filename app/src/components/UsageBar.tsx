import { useEffect, useState } from 'react'
import { AI_LABELS } from '@shared/ai'
import type { AiProvider, ProviderUsage } from '@shared/types'
import { formatCountdown, formatTokens, remainingPercent, usageSummary } from '@shared/usage'
import { C } from '../theme'
import { RefreshIcon } from './icons'

interface Props {
  usage: ProviderUsage[]
  provider: AiProvider
  onRefresh: () => void
}

function primary(usage: ProviderUsage): string {
  if (usage.credits !== undefined) return `$${usage.credits.toFixed(2)}`
  if (usage.keyCredits !== undefined) return `$${usage.keyCredits.toFixed(2)}`
  const window = usage.windows[0]
  if (!window) return '—'
  if (window.usedPercent !== undefined) {
    return `${window.label} ${Math.round(remainingPercent(window.usedPercent))}% left`
  }
  if (window.tokens !== undefined) return `${window.label} ${formatTokens(window.tokens)} tok`
  return window.label
}

/** The countdown and token count beside the main reading, when they add information. */
function detail(usage: ProviderUsage, now: number): string | undefined {
  const window = usage.windows[0]
  if (!window) return undefined
  const parts: string[] = []
  if (window.usedPercent !== undefined && window.tokens !== undefined) {
    parts.push(`${formatTokens(window.tokens)} tok`)
  }
  if (window.resetsAt !== undefined) parts.push(formatCountdown(window.resetsAt, now))
  return parts.length ? parts.join(' · ') : undefined
}

/** Usage for the active chat provider, kept next to the model that consumes it. */
export default function UsageBar({ usage, provider, onRefresh }: Props) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const entry = usage.find((item) => item.provider === provider)
  const ok = entry?.state === 'ok'
  const extra = entry && detail(entry, now)
  const reading = !entry ? 'Loading…' : ok ? primary(entry) : 'Unavailable'

  return (
    <div
      role="status"
      aria-label={`${AI_LABELS[provider]} usage`}
      title={entry ? usageSummary(entry, now) : `${AI_LABELS[provider]} usage is loading`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
        color: ok ? C.textMuted : C.faint,
        fontSize: 11,
        whiteSpace: 'nowrap'
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{reading}</span>
      {extra && <span style={{ color: C.faint }}>{extra}</span>}
      <button
        type="button"
        className="bf-focus bf-icon-btn"
        onClick={onRefresh}
        title="Refresh usage"
        aria-label="Refresh usage"
        style={{
          width: 18,
          height: 18,
          border: 0,
          borderRadius: 4,
          background: 'transparent',
          color: C.textMuted,
          display: 'grid',
          placeItems: 'center',
          cursor: 'pointer'
        }}
      >
        <RefreshIcon size={11} />
      </button>
    </div>
  )
}
