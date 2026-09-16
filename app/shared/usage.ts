/** Provider plan limits and OpenRouter balance for the persistent usage bar. */

import type { AiProvider } from './ai'

/** `ok` when at least one window or balance was read; `unavailable` otherwise. */
export type UsageState = 'ok' | 'unavailable'

/** One provider rate-limit window, e.g. Codex's 5-hour or Claude's weekly. */
export interface UsageWindow {
  /** Short label, e.g. `5h` or `7d`. */
  label: string
  /** Percent of the window used, when the provider reports it. */
  usedPercent?: number
  /** Epoch ms when the window resets, when the provider reports it. */
  resetsAt?: number
  /** Tokens used in the window, when the provider reports a count. */
  tokens?: number
}

export interface ProviderUsage {
  provider: AiProvider
  state: UsageState
  windows: UsageWindow[]
  /** OpenRouter account credit remaining, USD (`total_credits - total_usage`). */
  credits?: number
  /** OpenRouter inference-key allowance remaining, USD. */
  keyCredits?: number
  /** Why no reading is available, shown in the bar's tooltip. */
  message?: string
  /** Epoch ms this reading was taken. */
  updatedAt: number
}

export const MINUTE_MS = 60_000
export const FIVE_HOURS_MS = 5 * 60 * MINUTE_MS

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

export function remainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent))
}

/** `30m`, `5h`, `7d` — the shortest exact label for a window length. */
export function windowLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

/** OpenRouter `/credits`: what is left after `total_usage`. */
export function parseOpenRouterCredits(body: unknown): number | undefined {
  const data = record(record(body)?.data)
  const total = finite(data?.total_credits)
  const used = finite(data?.total_usage)
  if (total === undefined || used === undefined) return undefined
  return Math.max(0, total - used)
}

/** OpenRouter `/key`: the inference key's own remaining allowance. */
export function parseOpenRouterKeyAllowance(body: unknown): number | undefined {
  return finite(record(record(body)?.data)?.limit_remaining)
}

/** One `primary` or `secondary` rate-limit block. */
function rateLimitWindow(raw: unknown): UsageWindow | undefined {
  const window = record(raw)
  const used = finite(window?.used_percent)
  const minutes = finite(window?.window_minutes)
  if (used === undefined || minutes === undefined) return undefined
  const resetsAt = finite(window?.resets_at)
  return {
    label: windowLabel(minutes),
    usedPercent: used,
    ...(resetsAt !== undefined ? { resetsAt: resetsAt * 1000 } : {})
  }
}

/** Codex `token_count` payload → its primary and secondary windows. */
export function codexUsageWindows(payload: unknown): UsageWindow[] {
  const limits = record(record(payload)?.rate_limits)
  if (!limits) return []
  const windows = (['primary', 'secondary'] as const)
    .map((key) => rateLimitWindow(limits[key]))
    .filter((window): window is UsageWindow => window !== undefined)
  const tokens = finite(record(record(record(payload)?.info)?.total_token_usage)?.total_tokens)
  if (windows.length && tokens !== undefined) windows[0] = { ...windows[0], tokens }
  return windows
}

function messageTokens(event: Record<string, unknown>): number {
  const usage = record(record(event.message)?.usage)
  if (!usage) return 0
  return (finite(usage.input_tokens) ?? 0) + (finite(usage.output_tokens) ?? 0)
}

function quotaWindow(quota: Record<string, unknown> | undefined): UsageWindow | undefined {
  if (!quota) return undefined
  const type = typeof quota.rateLimitType === 'string' ? quota.rateLimitType : ''
  const resetsAt = finite(quota.resetsAt)
  return {
    label: type === 'five_hour' ? '5h' : type === 'seven_day' ? '7d' : 'Limit',
    ...(quota.status === 'rejected' ? { usedPercent: 100 } : {}),
    ...(resetsAt !== undefined ? { resetsAt: resetsAt * 1000 } : {})
  }
}

/** Claude transcript lines → any hit-limit window, plus tokens used since `since`. */
export function claudeTranscriptUsage(
  events: readonly unknown[],
  since: number
): { windows: UsageWindow[]; tokens: number } {
  let windows: UsageWindow[] = []
  let tokens = 0
  for (const raw of events) {
    const event = record(raw)
    if (!event) continue
    const at = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN
    if (at >= since) tokens += messageTokens(event)
    const window = quotaWindow(record(event.quotaLimits))
    if (window) windows = [window]
  }
  return { windows, tokens }
}

/** `1.2M`, `220k`, `950`. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

/** `2h 5m`, `3d 4h`, `resetting` once the window has passed. */
export function formatCountdown(resetsAt: number, now: number): string {
  const minutes = Math.ceil((resetsAt - now) / MINUTE_MS)
  if (minutes <= 0) return 'resetting'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** `5h · 64% left · resets 2h 5m · 220k tok`. */
export function windowSummary(window: UsageWindow, now: number): string {
  const parts = [window.label]
  if (window.usedPercent !== undefined) {
    parts.push(`${Math.round(remainingPercent(window.usedPercent))}% left`)
  }
  if (window.resetsAt !== undefined) parts.push(`resets ${formatCountdown(window.resetsAt, now)}`)
  if (window.tokens !== undefined) parts.push(`${formatTokens(window.tokens)} tok`)
  return parts.join(' · ')
}

/** Every line the bar shows for one provider, joined for its tooltip. */
export function usageSummary(usage: ProviderUsage, now: number): string {
  const lines = usage.windows.map((window) => windowSummary(window, now))
  if (usage.credits !== undefined) lines.push(`$${usage.credits.toFixed(2)} credits left`)
  if (usage.keyCredits !== undefined) lines.push(`$${usage.keyCredits.toFixed(2)} key allowance left`)
  if (usage.message) lines.push(usage.message)
  return lines.length ? lines.join('\n') : 'Limits unavailable'
}
