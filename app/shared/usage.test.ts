import { describe, expect, it } from 'vitest'
import {
  claudeTranscriptUsage,
  codexUsageWindows,
  formatCountdown,
  formatTokens,
  parseOpenRouterCredits,
  parseOpenRouterKeyAllowance,
  remainingPercent,
  usageSummary,
  windowLabel,
  windowSummary
} from './usage'

describe('OpenRouter balance', () => {
  it('reads credits left from total_credits minus total_usage', () => {
    expect(parseOpenRouterCredits({ data: { total_credits: 10, total_usage: 2.5 } })).toBe(7.5)
  })

  it('never reports negative credits', () => {
    expect(parseOpenRouterCredits({ data: { total_credits: 1, total_usage: 4 } })).toBe(0)
  })

  it('reads the inference key allowance', () => {
    expect(parseOpenRouterKeyAllowance({ data: { limit_remaining: 3.2 } })).toBe(3.2)
  })

  it('ignores malformed bodies', () => {
    expect(parseOpenRouterCredits(null)).toBeUndefined()
    expect(parseOpenRouterCredits({ data: { total_credits: '10' } })).toBeUndefined()
    expect(parseOpenRouterKeyAllowance({})).toBeUndefined()
  })
})

describe('codexUsageWindows', () => {
  it('labels windows by length and converts reset seconds to ms', () => {
    const windows = codexUsageWindows({
      info: { total_token_usage: { total_tokens: 220_422 } },
      rate_limits: {
        primary: { used_percent: 36, window_minutes: 300, resets_at: 1_789_570_018 },
        secondary: { used_percent: 94, window_minutes: 10080, resets_at: 1_789_912_192 }
      }
    })
    expect(windows).toEqual([
      { label: '5h', usedPercent: 36, resetsAt: 1_789_570_018_000, tokens: 220_422 },
      { label: '7d', usedPercent: 94, resetsAt: 1_789_912_192_000 }
    ])
  })

  it('returns nothing when there is no rate-limit block', () => {
    expect(codexUsageWindows({ info: {} })).toEqual([])
    expect(codexUsageWindows(null)).toEqual([])
  })
})

describe('claudeTranscriptUsage', () => {
  it('keeps a hit limit and sums tokens inside the window', () => {
    const since = Date.parse('2026-09-16T10:00:00.000Z')
    const result = claudeTranscriptUsage(
      [
        { timestamp: '2026-09-16T09:00:00.000Z', message: { usage: { input_tokens: 100, output_tokens: 50 } } },
        { timestamp: '2026-09-16T11:00:00.000Z', message: { usage: { input_tokens: 10, output_tokens: 5 } } },
        {
          timestamp: '2026-09-16T11:05:00.000Z',
          quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_789_411_200 }
        }
      ],
      since
    )
    expect(result.tokens).toBe(15)
    expect(result.windows).toEqual([
      { label: '5h', usedPercent: 100, resetsAt: 1_789_411_200_000 }
    ])
  })
})

describe('formatting', () => {
  it('labels window lengths exactly', () => {
    expect(windowLabel(300)).toBe('5h')
    expect(windowLabel(10080)).toBe('7d')
    expect(windowLabel(90)).toBe('90m')
  })

  it('reports remaining percent clamped to 0–100', () => {
    expect(remainingPercent(36)).toBe(64)
    expect(remainingPercent(-20)).toBe(100)
    expect(remainingPercent(150)).toBe(0)
  })

  it('formats token counts compactly', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(220_422)).toBe('220k')
    expect(formatTokens(1_234_567)).toBe('1.2M')
  })

  it('formats reset countdowns', () => {
    const now = 1_000_000
    expect(formatCountdown(now + 45 * 60_000 + 30_000, now)).toBe('46m')
    expect(formatCountdown(now + 125 * 60_000, now)).toBe('2h 5m')
    expect(formatCountdown(now + 3 * 24 * 60 * 60_000, now)).toBe('3d 0h')
    expect(formatCountdown(now - 1, now)).toBe('resetting')
  })

  it('describes a window and a whole provider', () => {
    const now = 1_000_000
    const window = { label: '5h', usedPercent: 36, resetsAt: now + 125 * 60_000, tokens: 220_422 }
    expect(windowSummary(window, now)).toBe('5h · 64% left · resets 2h 5m · 220k tok')
    expect(
      usageSummary({ provider: 'codex', state: 'ok', windows: [window], updatedAt: now }, now)
    ).toBe('5h · 64% left · resets 2h 5m · 220k tok')
    expect(
      usageSummary(
        { provider: 'openrouter', state: 'ok', windows: [], credits: 7.5, keyCredits: 2, updatedAt: now },
        now
      )
    ).toBe('$7.50 credits left\n$2.00 key allowance left')
  })
})
