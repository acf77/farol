import { RUN_ONBOARDING_EVENT } from '../onboarding-event'
import { Children, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { activePromptCount, type CustomPromptSet } from '@shared/custom-prompts'
import type { ProviderKey } from '@shared/ai'
import type { AgentMode, AppSettings, ModelChoice, SettingsResult } from '@shared/types'
import {
  AI_LABELS,
  normalizeOpenRouterAgent,
  OPENROUTER_AGENT_LABELS,
  OPENROUTER_AGENTS,
  pickerProviders,
  type AiProvider
} from '@shared/ai'
import { AI_GATEWAY_API_URL, JEV_MODEL_ID } from '@shared/jev'
import { OPENROUTER_API_URL } from '@shared/openrouter'
import {
  withAgentModel,
  withCommitMessageModel,
  withModeChain,
  withPipelineChain,
  withOpenRouterAgent
} from '@shared/settings'
import {
  SPEND_DAYS,
  SPEND_KEY_HINTS,
  SPEND_LABELS,
  SPEND_PROVIDERS,
  dailyCost,
  daysAgo,
  formatUsd,
  heatCuts,
  heatLevel,
  totalsSince,
  type ProviderSpend,
  type SpendKeyStatus,
  type SpendProvider,
  type SpendReport
} from '@shared/spend'
import { formatTokens } from '@shared/usage'
import { C, UI } from '../theme'
import { Button, Checkbox, CliModelDropdown, SegmentedControl, Switch } from './controls'
import { CustomPromptsSection } from './CustomPromptsSection'
import { ChevronDown, ChevronUp } from './icons'
import { CHROME_ROW } from './side-panel'

interface Props {
  settings: AppSettings
  onSettings: (next: AppSettings) => void
  /** Adopt settings the main process already owns — provider keys, catalogs. */
  onAdoptSettings: (next: AppSettings) => void
  onClose: () => void
  /** The open project, whose `.farol/prompts.json` Custom prompts edits. */
  projectPath?: string | null
  projectName?: string
}

type PageKey = 'general' | 'prompts' | 'models' | 'fallbacks' | 'openrouter' | 'keys' | 'jev' | 'usage'

const PAGES: readonly { value: PageKey; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'prompts', label: 'Custom prompts' },
  { value: 'models', label: 'Models' },
  { value: 'fallbacks', label: 'Fallbacks' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'keys', label: 'API keys' },
  { value: 'jev', label: 'Jev' },
  { value: 'usage', label: 'Usage' }
]

const OPENROUTER_AGENT_OPTIONS = OPENROUTER_AGENTS.map((value) => ({
  value,
  label: OPENROUTER_AGENT_LABELS[value]
}))

const card: React.CSSProperties = {
  border: `1px solid ${C.hair}`,
  borderRadius: 12,
  background: C.sidebar,
  minWidth: 0
}

const mono = "ui-monospace, 'SF Mono', Menlo, monospace"

const field: React.CSSProperties = {
  height: 30,
  padding: '0 10px',
  borderRadius: 7,
  border: `1px solid ${C.border}`,
  background: C.app,
  color: C.text,
  fontSize: 12
}

/** Save, replace, or clear one encrypted provider key. */
function ApiKeyField({
  configured,
  placeholder,
  busy,
  onSave,
  onClear
}: {
  configured: boolean
  placeholder: string
  busy: boolean
  /** Resolves true once the key is stored, which is when the draft is cleared. */
  onSave: (key: string) => Promise<boolean>
  onClear: () => void
}) {
  const [draft, setDraft] = useState('')
  const [replace, setReplace] = useState(false)

  if (configured && !replace) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
        <span style={{ flex: 1, fontFamily: mono, fontSize: 12, color: C.textMuted }}>••••••••</span>
        <Button variant="ghost" onClick={() => setReplace(true)}>
          Replace
        </Button>
        <Button variant="danger" disabled={busy} onClick={onClear}>
          Clear
        </Button>
      </div>
    )
  }

  return (
    <form
      style={{ display: 'flex', gap: 8, flex: 1, minWidth: 0 }}
      onSubmit={(e) => {
        e.preventDefault()
        void onSave(draft).then((saved) => {
          if (!saved) return
          setDraft('')
          setReplace(false)
        })
      }}
    >
      <input
        className="bf-input bf-focus"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        style={{ ...field, flex: 1, minWidth: 0, fontFamily: mono }}
      />
      <Button type="submit" variant="primary" disabled={busy || !draft.trim()}>
        Save
      </Button>
      {configured && (
        <Button type="button" variant="ghost" onClick={() => setReplace(false)}>
          Cancel
        </Button>
      )}
    </form>
  )
}


const EYEBROW: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: C.faint
}

/** Uppercase eyebrow over one card; `aside` sits on the right of the eyebrow. */
function Group({
  title,
  count,
  aside,
  foot,
  children
}: {
  title: string
  count?: string
  aside?: React.ReactNode
  foot?: string
  children: React.ReactNode
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 }}>
        <span style={EYEBROW}>{title}</span>
        {count && <span style={{ fontSize: 11, color: C.fainter }}>{count}</span>}
        <span style={{ flex: 1 }} />
        {aside}
      </div>
      {children}
      {foot && <span style={{ fontSize: 12, color: C.faint, textWrap: 'pretty' }}>{foot}</span>}
    </section>
  )
}

/** Rounded card whose children are separated by hairlines. */
function Card({ children, clip }: { children: React.ReactNode; clip?: boolean }) {
  return (
    <div style={{ ...card, overflow: clip ? 'hidden' : undefined }}>
      {Children.toArray(children).map((child, i) => (
        <div key={i} style={i ? { borderTop: `1px solid ${C.hair}` } : undefined}>
          {child}
        </div>
      ))}
    </div>
  )
}

const ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px' }

function Blurb({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: '14px 16px 4px', fontSize: 12, lineHeight: 1.55, color: C.faint, textWrap: 'pretty' }}>
      {children}
    </div>
  )
}

/** Title and description on the left, the control on the right. */
function Setting({
  title,
  hint,
  icon,
  width,
  children
}: {
  title: string
  hint?: string
  icon?: React.ReactNode
  width?: number
  children: React.ReactNode
}) {
  return (
    <div style={ROW}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          {icon}
          {title}
        </span>
        {hint && <span style={{ fontSize: 12, color: C.faint, textWrap: 'pretty' }}>{hint}</span>}
      </div>
      <div style={{ width, flex: width ? 'none' : undefined, minWidth: 0 }}>{children}</div>
    </div>
  )
}

/** Fixed-width label with its control or value beside it. */
function Field({ label, width = 100, children }: { label: string; width?: number; children: React.ReactNode }) {
  return (
    <div style={ROW}>
      <span style={{ width, flex: 'none', fontSize: 13 }}>{label}</span>
      {children}
    </div>
  )
}

function Value({ children }: { children: React.ReactNode }) {
  return <span style={{ flex: 1, minWidth: 0, fontFamily: mono, fontSize: 12, color: C.textMuted }}>{children}</span>
}

function RefreshButton({ title, disabled, onClick }: { title: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Button variant="ghost" aria-label={title} title={title} disabled={disabled} onClick={onClick}>
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M12 7a5 5 0 1 1-1.5-3.6" />
        <path d="M11 1.5v2.5H8.5" />
      </svg>
    </Button>
  )
}

function StatusText({ busy, ok, error }: { busy: boolean; ok?: string | null; error?: string | null }) {
  if (busy) return <span style={{ fontSize: 11.5, color: C.faint }}>Working…</span>
  if (error) return <span style={{ fontSize: 11.5, color: C.red }}>{error}</span>
  if (ok) return <span style={{ fontSize: 11.5, color: C.green }}>{ok}</span>
  return null
}

const ActionRow = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '8px 10px' }}>
    {children}
  </div>
)

const PROVIDER_KEY_FIELDS: readonly { name: ProviderKey; label: string; placeholder: string }[] = [
  { name: 'anthropic', label: 'Anthropic (Claude)', placeholder: 'sk-ant-…' },
  { name: 'openai', label: 'OpenAI (Codex)', placeholder: 'sk-…' }
]

/** Direct vendor keys bill API credits instead of the CLI's own login. */
function ProviderKeysSection({
  settings,
  onSettings,
  onAdoptSettings
}: {
  settings: AppSettings
  onSettings: (next: AppSettings) => void
  onAdoptSettings: (next: AppSettings) => void
}) {
  const api = window.farol
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = (call: Promise<SettingsResult>): Promise<boolean> => {
    setBusy(true)
    return call
      .then((result) => {
        onAdoptSettings(result.settings)
        setError(result.error ?? null)
        return !result.error
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        return false
      })
      .finally(() => setBusy(false))
  }

  return (
    <Group title="API keys">
      <Card>
        <Blurb>
          With a key on, API credits pay for that provider's runs. Switch it off to use the CLI login again. The interactive Codex terminal always uses the Codex login.
        </Blurb>
        {PROVIDER_KEY_FIELDS.map(({ name, label, placeholder }) => (
          <Field key={name} label={label}>
            {settings.providerKeys?.[name] && (
              <Switch
                label={`Use ${label} key`}
                checked={!settings.providerKeysOff?.includes(name)}
                onChange={(on) => {
                  if (busy) return
                  const rest = (settings.providerKeysOff ?? []).filter((k) => k !== name)
                  onSettings({ ...settings, providerKeysOff: on ? rest : [...rest, name] })
                }}
              />
            )}
            <ApiKeyField
              configured={!!settings.providerKeys?.[name]}
              placeholder={placeholder}
              busy={busy}
              onSave={(key) => run(api.providerKey.save(name, key))}
              onClear={() => void run(api.providerKey.clear(name))}
            />
          </Field>
        ))}
        <ActionRow>
          <StatusText busy={busy} error={error} ok={null} />
        </ActionRow>
      </Card>
    </Group>
  )
}

/**
 * Jev never reaches a model picker — Farol calls it for its own decisions — so
 * the only thing to configure is the gateway key those calls go out with.
 */
function JevSection({
  settings,
  onAdoptSettings
}: {
  settings: AppSettings
  onAdoptSettings: (next: AppSettings) => void
}) {
  const api = window.farol
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [probed, setProbed] = useState(false)
  const configured = !!settings.jev?.hasKey

  const run = (call: Promise<SettingsResult>): Promise<boolean> => {
    setBusy(true)
    return call.then((result) => {
      onAdoptSettings(result.settings)
      setError(result.error ?? null)
      setProbed(!result.error)
      setBusy(false)
      return !result.error
    })
  }

  return (
    <Group
      title="Jev"
      aside={
        <span
          style={{
            fontSize: 11,
            padding: '1px 6px',
            borderRadius: 4,
            background: 'oklch(0.73 0.16 300 / 0.12)',
            color: C.purpleSoft
          }}
        >
          Internal
        </span>
      }
    >
      <Card>
        <Blurb>
          Farol&apos;s internal decisions only. Jev writes no text, so it is not offered to Chat or to pipeline steps.
        </Blurb>
        <Field label="Model">
          <Value>{JEV_MODEL_ID}</Value>
        </Field>
        <Field label="Gateway">
          <Value>{AI_GATEWAY_API_URL}</Value>
        </Field>
        <Field label="API key">
          <ApiKeyField
            configured={configured}
            placeholder="vck_…"
            busy={busy}
            onSave={(key) => run(api.jev.saveKey(key))}
            onClear={() => void run(api.jev.clearKey())}
          />
        </Field>
        <ActionRow>
          <StatusText
            busy={busy}
            error={error}
            ok={configured && probed ? 'Jev answered the check question.' : null}
          />
          <Button variant="secondary" disabled={busy || !configured} onClick={() => void run(api.jev.check())}>
            Test connection
          </Button>
        </ActionRow>
      </Card>
    </Group>
  )
}

/**
 * One mode's ordered chain. Farol starts a chat on the top rung and walks down
 * whenever a CLI fails for reasons the agent cannot fix (missing binary,
 * non-zero exit, usage or quota limit).
 */
function ModeChain({
  mode,
  settings,
  onSettings
}: {
  mode: AgentMode | 'pipelines'
  settings: AppSettings
  onSettings: (next: AppSettings) => void
}) {
  const chain = mode === 'pipelines' ? settings.pipelineFallbacks : settings.modeDefaults[mode]
  const save = (next: ModelChoice[]): void =>
    onSettings(
      mode === 'pipelines' ? withPipelineChain(settings, next) : withModeChain(settings, mode, next)
    )
  const move = (from: number, to: number): void => {
    const next = [...chain]
    const [rung] = next.splice(from, 1)
    next.splice(to, 0, rung)
    save(next)
  }
  const fallback = pickerProviders(settings.openrouter)[0]
  const title = { plan: 'Plan mode', build: 'Build mode', pipelines: 'Pipelines' }[mode]
  const foot = {
    plan: 'Leave empty to keep whichever model the chat is already on.',
    build: undefined,
    pipelines:
      'Tried when an AI pipeline step cannot run on its own model — CLI missing, usage or quota limit. Leave empty for no fallback.'
  }[mode]
  const empty = {
    plan: 'Empty — plan mode keeps whichever model the chat is already on.',
    build: 'Empty — build mode uses the default model only.',
    pipelines: 'Empty — AI pipeline steps do not fall back.'
  }[mode]

  return (
    <Group
      title={title}
      count={String(chain.length)}
      aside={
        <Button variant="ghost" disabled={!fallback} onClick={() => fallback && save([...chain, { agent: fallback }])}>
          + Add fallback
        </Button>
      }
      foot={foot}
    >
      <Card>
        {chain.length === 0 ? (
          <div style={{ padding: '14px 16px', fontSize: 12.5, color: C.faint }}>
            {empty}
          </div>
        ) : (
          chain.map((rung, i) => (
            <div
              key={`${rung.agent}:${rung.model ?? ''}`}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px 8px 16px' }}
            >
              <span style={{ width: 18, flex: 'none', fontFamily: mono, fontSize: 11.5, color: C.fainter }}>
                {i + 1}.
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <CliModelDropdown
                  label={`${title} model ${i + 1}`}
                  provider={rung.agent}
                  model={rung.model}
                  settings={settings}
                  onChange={(agent, model) =>
                    save(chain.map((r, at) => (at === i ? { agent, ...(model ? { model } : {}) } : r)))
                  }
                />
              </div>
              {i === 0 && (
                <span
                  style={{
                    flex: 'none',
                    fontSize: 10.5,
                    fontWeight: 600,
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: 'oklch(0.91 0.19 115 / 0.14)',
                    color: C.accent
                  }}
                >
                  FIRST
                </span>
              )}
              <div style={{ display: 'flex', gap: 2, flex: 'none' }}>
                <Button
                  variant="ghost"
                  aria-label={`Move model ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => move(i, i - 1)}
                >
                  <ChevronUp size={11} color="currentColor" />
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`Move model ${i + 1} down`}
                  disabled={i === chain.length - 1}
                  onClick={() => move(i, i + 1)}
                >
                  <ChevronDown size={11} color="currentColor" />
                </Button>
                <Button
                  variant="danger"
                  aria-label={`Remove model ${i + 1}`}
                  onClick={() => save(chain.filter((_, at) => at !== i))}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))
        )}
      </Card>
    </Group>
  )
}

const SPEND_COLORS: Record<SpendProvider, string> = {
  anthropic: 'oklch(0.76 0.12 55)',
  openai: 'oklch(0.78 0.09 200)',
  openrouter: 'oklch(0.91 0.19 115)'
}
const SPEND_RANGES = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' }
] as const
const HEAT_WEEKS = 14
const HEAT_CELL = 13
const DAY_MS = 86_400_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function utcDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`)
}

function dayLabel(date: string): string {
  const d = utcDate(date)
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

/** API spend from the providers' admin endpoints: a daily heatmap and per-model tables. */
function UsageSection() {
  const api = window.farol
  const [report, setReport] = useState<SpendReport | null>(null)
  const [keys, setKeys] = useState<SpendKeyStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [range, setRange] = useState<number>(30)
  const [filter, setFilter] = useState<SpendProvider | 'all'>('all')
  const [hover, setHover] = useState<string | null>(null)

  const load = useCallback(
    (force?: boolean): void => {
      setLoading(true)
      void Promise.all([api.usage.spendKeys(), api.usage.spend(force)])
        .then(([status, next]) => {
          setKeys(status)
          setReport(next)
        })
        .catch(() => undefined)
        .finally(() => setLoading(false))
    },
    [api.usage]
  )

  useEffect(() => load(), [load])

  const saveKey = (name: SpendProvider, key: string): Promise<boolean> => {
    setKeyBusy(true)
    setKeyError(null)
    return api.usage
      .saveSpendKey(name, key)
      .then((result) => {
        setKeys(result.status)
        setKeyError(result.error ?? null)
        if (!result.error) load(true)
        return !result.error
      })
      .catch(() => false)
      .finally(() => setKeyBusy(false))
  }
  const clearKey = (name: SpendProvider): void => {
    void api.usage.clearSpendKey(name).then((result) => {
      setKeys(result.status)
      load(true)
    })
  }

  const providers = report?.providers ?? []
  const live = providers.filter((p) => p.state === 'ok')
  const today = new Date()
  const from = daysAgo(today, range - 1)
  const totals = live.map((p) => totalsSince(p, from))
  const total = totals.reduce((t, p) => t + p.cost, 0)
  const tokens = totals.reduce((t, p) => t + p.tokens, 0)

  const shown: ProviderSpend[] = filter === 'all' ? live : live.filter((p) => p.provider === filter)
  const perDay = new Map<string, number>()
  const perDayBy = new Map<string, Partial<Record<SpendProvider, number>>>()
  for (const p of shown) {
    for (const [date, cost] of dailyCost(p)) {
      perDay.set(date, (perDay.get(date) ?? 0) + cost)
      perDayBy.set(date, { ...perDayBy.get(date), [p.provider]: cost })
    }
  }
  const cuts = heatCuts([...perDay.values()])
  const heatBase = filter === 'all' ? C.accent : SPEND_COLORS[filter]
  const heat = [
    'oklch(1 0 0 / 0.05)',
    ...[0.22, 0.42, 0.68].map((a) => heatBase.replace(')', ` / ${a})`)),
    heatBase
  ]
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const gridStart = todayUtc - today.getUTCDay() * DAY_MS - (HEAT_WEEKS - 1) * 7 * DAY_MS
  const dateAt = (index: number): string => new Date(gridStart + index * DAY_MS).toISOString().slice(0, 10)
  const todayStr = dateAt(Math.round((todayUtc - gridStart) / DAY_MS))
  const weeks = Array.from({ length: HEAT_WEEKS }, (_, w) => {
    const first = utcDate(dateAt(w * 7))
    const prev = utcDate(dateAt(w * 7 - 7))
    return {
      month: w === 0 || first.getUTCMonth() !== prev.getUTCMonth() ? MONTHS[first.getUTCMonth()] : '',
      days: Array.from({ length: 7 }, (_, k) => dateAt(w * 7 + k))
    }
  })

  const hoverText = (() => {
    if (!hover) return `Daily spend${filter === 'all' ? '' : ` · ${SPEND_LABELS[filter]}`} · hover a day`
    const value = perDay.get(hover) ?? 0
    const by = perDayBy.get(hover) ?? {}
    const split =
      filter === 'all' && value > 0
        ? ' · ' +
          SPEND_PROVIDERS.filter((p) => by[p]).map((p) => `${SPEND_LABELS[p]} ${formatUsd(by[p] ?? 0)}`).join(', ')
        : ''
    return `${dayLabel(hover)} · ${value > 0 ? formatUsd(value) : 'No usage'}${split}`
  })()

  const chip = (value: SpendProvider | 'all', name: string, color: string, cost: number) => {
    const on = filter === value
    return (
      <button
        key={value}
        type="button"
        className="bf-focus"
        aria-pressed={on}
        onClick={() => setFilter(value)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '4px 10px',
          border: 'none',
          borderRadius: 7,
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 12,
          background: on ? 'oklch(1 0 0 / 0.07)' : 'transparent',
          boxShadow: on ? 'inset 0 0 0 1px oklch(1 0 0 / 0.1)' : undefined,
          color: on ? C.text : C.textMuted
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 2, flex: 'none', background: color }} />
        <span>{name}</span>
        <span style={{ color: C.faint, fontVariantNumeric: 'tabular-nums' }}>{formatUsd(cost)}</span>
      </button>
    )
  }

  const anyKey = !!keys && SPEND_PROVIDERS.some((p) => keys[p])

  return (
    <>
      {anyKey && (
        <Group
          title="API usage"
          aside={
            <>
              {loading && <StatusText busy ok={null} error={null} />}
              <RefreshButton title="Refresh usage" disabled={loading} onClick={() => load(true)} />
              <SegmentedControl
                label="Usage range"
                options={SPEND_RANGES.map((r) => ({ value: String(r.value), label: r.label }))}
                value={String(range)}
                onChange={(next) => setRange(Number(next))}
                style={{ width: 210 }}
              />
            </>
          }
          foot="Counts calls made with your API keys. Subscription logins in the Claude and Codex CLIs are not included. Providers report a day only after it ends (UTC), so today's usage appears tomorrow."
        >
          <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <span style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-.01em', fontVariantNumeric: 'tabular-nums' }}>
                {formatUsd(total)}
              </span>
              <span style={{ fontSize: 12, color: C.textMuted }}>
                {formatTokens(tokens)} tokens · last {range} days
              </span>
            </div>
            <div
              role="img"
              aria-label="Daily API spend"
              onMouseLeave={() => setHover(null)}
              style={{ display: 'flex', flexDirection: 'column', gap: 4, overflowX: 'auto' }}
            >
              <div style={{ display: 'flex', gap: 3, paddingLeft: 30, height: 14 }}>
                {weeks.map((w, i) => (
                  <span key={i} style={{ width: HEAT_CELL, flex: 'none', fontSize: 10.5, color: C.faint, whiteSpace: 'nowrap', overflow: 'visible' }}>
                    {w.month}
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 3 }}>
                <div
                  style={{
                    width: 27,
                    flex: 'none',
                    display: 'grid',
                    gridTemplateRows: `repeat(7, ${HEAT_CELL}px)`,
                    gap: 3,
                    fontSize: 10,
                    color: C.faint
                  }}
                >
                  {WEEKDAYS.map((d, i) => (
                    <span key={d} style={{ lineHeight: `${HEAT_CELL}px` }}>
                      {i % 2 === 1 ? d : ''}
                    </span>
                  ))}
                </div>
                {weeks.map((w, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateRows: `repeat(7, ${HEAT_CELL}px)`, gap: 3, flex: 'none' }}>
                    {w.days.map((date) => {
                      const future = date > todayStr
                      return (
                        <div
                          key={date}
                          onMouseEnter={future ? undefined : () => setHover(date)}
                          style={{
                            width: HEAT_CELL,
                            height: HEAT_CELL,
                            borderRadius: 3,
                            visibility: future ? 'hidden' : undefined,
                            background: heat[heatLevel(perDay.get(date) ?? 0, cuts)],
                            opacity: date >= from ? 1 : 0.35,
                            outline: hover === date ? `1px solid ${C.text}` : undefined,
                            outlineOffset: 1
                          }}
                        />
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px 14px', flexWrap: 'wrap', fontSize: 12 }}>
              <span style={{ color: C.textMuted, fontVariantNumeric: 'tabular-nums', minWidth: 0 }}>{hoverText}</span>
              <span style={{ flex: 1 }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 3, color: C.faint, fontSize: 11 }}>
                <span style={{ marginRight: 4 }}>Less</span>
                {heat.map((c, i) => (
                  <span key={i} style={{ width: 11, height: 11, borderRadius: 3, background: c }} />
                ))}
                <span style={{ marginLeft: 4 }}>More</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 12, borderTop: `1px solid ${C.hair}` }}>
              {chip('all', 'All', C.text, total)}
              {live.map((p, i) => chip(p.provider, SPEND_LABELS[p.provider], SPEND_COLORS[p.provider], totals[i].cost))}
            </div>
          </div>
        </Group>
      )}

      {providers
        .filter((p) => p.state === 'error')
        .map((p) => (
          <div key={p.provider} style={{ fontSize: 12, color: C.red }}>
            {SPEND_LABELS[p.provider]}: {p.message}
          </div>
        ))}

      {totals.map((t) => {
        const peak = Math.max(...t.models.map((m) => m.cost), 0.0001)
        const grid = 'minmax(0,1fr) 64px 64px 76px'
        return (
          <Group
            key={t.provider}
            title={SPEND_LABELS[t.provider]}
            count={`${t.models.length} ${t.models.length === 1 ? 'model' : 'models'}`}
            aside={<span style={{ fontSize: 12, color: C.textRow, fontVariantNumeric: 'tabular-nums' }}>{formatUsd(t.cost)}</span>}
          >
            <div style={card}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: grid,
                  gap: 12,
                  padding: '8px 16px',
                  fontSize: 11,
                  color: C.faint,
                  borderBottom: `1px solid ${C.hair}`
                }}
              >
                <span>Model</span>
                <span style={{ textAlign: 'right' }}>Input</span>
                <span style={{ textAlign: 'right' }}>Output</span>
                <span style={{ textAlign: 'right' }}>Cost</span>
              </div>
              {t.models.length === 0 && (
                <div style={{ padding: '14px 16px', fontSize: 12.5, color: C.faint }}>No usage in this range.</div>
              )}
              {t.models.map((m, i) => (
                <div
                  key={m.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: grid,
                    gap: 12,
                    alignItems: 'center',
                    padding: '10px 16px',
                    borderTop: i ? `1px solid ${C.hair}` : undefined
                  }}
                >
                  <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.id}>
                      {m.name}
                    </span>
                    <div style={{ height: 3, borderRadius: 2, background: 'oklch(1 0 0 / 0.05)' }}>
                      <div
                        style={{
                          height: 3,
                          borderRadius: 2,
                          width: `${Math.max(2, (m.cost / peak) * 100)}%`,
                          background: SPEND_COLORS[t.provider]
                        }}
                      />
                    </div>
                  </div>
                  <span style={{ textAlign: 'right', fontFamily: mono, fontSize: 11.5, color: C.textMuted }}>
                    {formatTokens(m.input)}
                  </span>
                  <span style={{ textAlign: 'right', fontFamily: mono, fontSize: 11.5, color: C.textMuted }}>
                    {formatTokens(m.output)}
                  </span>
                  <span style={{ textAlign: 'right', fontFamily: mono, fontSize: 12 }}>{formatUsd(m.cost)}</span>
                </div>
              ))}
            </div>
          </Group>
        )
      })}

      <Group title="Admin keys" foot={`Read-only reports for the last ${SPEND_DAYS} days. These are separate from the keys your runs use.`}>
        <Card>
          <Blurb>
            Usage comes from each provider&apos;s organization reports, so it needs an admin key rather than a regular API key.
          </Blurb>
          {SPEND_PROVIDERS.map((name) => (
            <Field key={name} label={SPEND_KEY_HINTS[name].label} width={170}>
              <ApiKeyField
                configured={!!keys?.[name]}
                placeholder={SPEND_KEY_HINTS[name].placeholder}
                busy={keyBusy}
                onSave={(key) => saveKey(name, key)}
                onClear={() => clearKey(name)}
              />
            </Field>
          ))}
          <ActionRow>
            <StatusText busy={keyBusy} error={keyError} ok={null} />
          </ActionRow>
        </Card>
      </Group>
    </>
  )
}

export default function SettingsPage({
  settings,
  onSettings,
  onAdoptSettings,
  onClose,
  projectPath,
  projectName
}: Props) {
  const api = window.farol
  const or = settings.openrouter
  const configured = !!or?.hasKey
  const orAgent = normalizeOpenRouterAgent(or?.agent)
  const [page, setPage] = useState<PageKey>('general')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [listsHint, setListsHint] = useState<string | null>(null)
  const [promptCount, setPromptCount] = useState(0)
  const promptRevision = useRef(0)
  const listsRefreshed = useRef(false)
  const updatePromptCount = useCallback((set: CustomPromptSet) => {
    promptRevision.current += 1
    setPromptCount(activePromptCount(set))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let live = true
    const revision = ++promptRevision.current
    setPromptCount(0)
    void api.prompts
      .load(projectPath ?? null)
      .then((set) => {
        if (live && revision === promptRevision.current) setPromptCount(activePromptCount(set))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [api.prompts, projectPath])

  const retried = useRef(false)
  useEffect(() => {
    if (retried.current || !configured || or?.autoPinned) return
    retried.current = true
    setBusy(true)
    void api.openrouter.refresh().then((result) => {
      onAdoptSettings(result.settings)
      setError(result.error ?? null)
      setBusy(false)
    })
  }, [api.openrouter, configured, onAdoptSettings, or?.autoPinned])

  const apply = (result: SettingsResult): boolean => {
    onAdoptSettings(result.settings)
    setError(result.error ?? null)
    setBusy(false)
    return !result.error
  }

  const refreshLists = (): void => {
    setBusy(true)
    setListsHint(null)
    void api.agentModels.refresh(true).then((result) => {
      setListsHint(apply(result) ? 'Updated' : (result.error ?? 'Could not refresh'))
    })
  }

  useEffect(() => {
    if (page !== 'models' || listsRefreshed.current) return
    listsRefreshed.current = true
    refreshLists()
  }, [page])

  const providers = pickerProviders(or)
  const catalog = or?.catalog ?? []
  const pinned = new Set(or?.pinned ?? [])
  const q = query.trim().toLowerCase()
  const visible = q
    ? catalog.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(q))
    : catalog
  const meta: Partial<Record<PageKey, string>> = {
    prompts: promptCount ? String(promptCount) : '',
    fallbacks: String(
      settings.modeDefaults.build.length +
        settings.modeDefaults.plan.length +
        settings.pipelineFallbacks.length
    ),
    openrouter: configured ? String(pinned.size) : ''
  }

  return createPortal(
    <div
      role="dialog"
      aria-label="Settings"
      className="bf-page-overlay"
      style={{
        position: 'fixed',
        inset: `${CHROME_ROW}px 0 0`,
        zIndex: 90,
        display: 'flex',
        flexDirection: 'column',
        background: C.app,
        color: C.text,
        fontFamily: UI
      }}
    >
      <div
        style={{
          height: 52,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px 0 18px',
          borderBottom: `1px solid ${C.hair}`
        }}
      >
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>Settings</span>
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <nav
          aria-label="Settings section"
          style={{
            width: 196,
            flex: 'none',
            padding: '18px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            borderRight: `1px solid ${C.hair}`
          }}
        >
          {PAGES.map(({ value, label }) => {
            const on = page === value
            return (
              <button
                key={value}
                type="button"
                className="bf-focus"
                aria-current={on ? 'page' : undefined}
                onClick={() => setPage(value)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '7px 10px',
                  border: 'none',
                  borderRadius: 7,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  textAlign: 'left',
                  background: on ? 'oklch(1 0 0 / 0.07)' : 'transparent',
                  color: on ? C.text : C.textMuted
                }}
              >
                <span style={{ flex: 1 }}>{label}</span>
                <span style={{ fontSize: 11, color: C.faint }}>{meta[value]}</span>
              </button>
            )
          })}
        </nav>

        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          <div
            style={{
              maxWidth: 680,
              margin: '0 auto',
              padding: '36px 32px 80px',
              display: 'flex',
              flexDirection: 'column',
              gap: 32
            }}
          >
            {page === 'general' && (
              <>
                <Group title="Agent">
                  <Card>
                    <Setting title="Default agent" hint="Starts new chats and picks up failures sent from a run." width={220}>
                      <select
                        className="bf-input bf-focus"
                        aria-label="Default agent"
                        value={settings.agent}
                        onChange={(e) => onSettings({ ...settings, agent: e.target.value as AiProvider })}
                        style={{ ...field, width: '100%' }}
                      >
                        {providers.map((p) => (
                          <option key={p} value={p}>
                            {AI_LABELS[p]}
                          </option>
                        ))}
                      </select>
                    </Setting>
                    <Setting title="Send failures to Chat" hint="Send a failed step's report straight to Chat.">
                      <Switch
                        label="Send failures to Chat"
                        checked={settings.autoFix}
                        onChange={(autoFix) => onSettings({ ...settings, autoFix })}
                      />
                    </Setting>
                  </Card>
                </Group>
                {import.meta.env.DEV && (
                  <Group title="Developer">
                    <Card>
                      <Setting title="First-run setup" hint="Reopen the onboarding screens. Development builds only.">
                        <Button
                          onClick={() => {
                            onClose()
                            window.dispatchEvent(new Event(RUN_ONBOARDING_EVENT))
                          }}
                        >
                          Run setup
                        </Button>
                      </Setting>
                    </Card>
                  </Group>
                )}
              </>
            )}

            {page === 'prompts' && (
              <CustomPromptsSection
                projectPath={projectPath ?? null}
                projectName={projectName}
                onChange={updatePromptCount}
              />
            )}

            {page === 'models' && (
              <>
                <Group
                  title="Default model"
                  foot="Each agent starts new chats with the model picked here. Pipeline steps keep their own. Lists refresh from the installed CLIs."
                  aside={
                    <>
                      <StatusText busy={busy} error={listsHint === 'Updated' ? null : listsHint} ok={listsHint === 'Updated' ? 'Updated' : null} />
                      <RefreshButton title="Refresh model lists" disabled={busy} onClick={refreshLists} />
                    </>
                  }
                >
                  <Card>
                    {providers.map((p) => (
                      <div key={p} style={{ ...ROW, padding: '9px 16px' }}>
                        <span style={{ width: 110, flex: 'none', fontSize: 13 }}>{AI_LABELS[p]}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <CliModelDropdown
                            label={`${AI_LABELS[p]} default model`}
                            provider={p}
                            model={settings.models[p]}
                            settings={settings}
                            locked
                            onChange={(_agent, model) => onSettings(withAgentModel(settings, p, model))}
                          />
                        </div>
                      </div>
                    ))}
                  </Card>
                </Group>
                <Group title="Commit messages">
                  <Card>
                    <Setting
                      title="Generator"
                      icon={<span style={{ color: C.purpleSoft, fontSize: 12 }}>✦</span>}
                      hint="Used only when Git drafts a commit message. It does not follow the chat default."
                      width={260}
                    >
                      <CliModelDropdown
                        label="Commit message provider and model"
                        provider={settings.commitMessage.agent}
                        model={settings.commitMessage.model}
                        settings={settings}
                        onChange={(agent, model) => onSettings(withCommitMessageModel(settings, agent, model))}
                      />
                    </Setting>
                  </Card>
                </Group>
              </>
            )}

            {page === 'fallbacks' && (
              <>
                <span style={{ fontSize: 12.5, lineHeight: 1.55, color: C.textMuted, textWrap: 'pretty' }}>
                  New chats start on the first model. If it fails — CLI missing, non-zero exit, usage or quota limit —
                  Farol retries the same turn on the next one down.
                </span>
                <ModeChain mode="build" settings={settings} onSettings={onSettings} />
                <ModeChain mode="plan" settings={settings} onSettings={onSettings} />
                <ModeChain mode="pipelines" settings={settings} onSettings={onSettings} />
              </>
            )}

            {page === 'openrouter' && (
              <>
                <Group title="Connection">
                  <Card>
                    <Field label="Endpoint">
                      <Value>{OPENROUTER_API_URL}</Value>
                    </Field>
                    <Field label="API key">
                      <ApiKeyField
                        configured={configured}
                        placeholder="sk-or-…"
                        busy={busy}
                        onSave={(key) => {
                          setBusy(true)
                          return api.openrouter.saveKey(key).then(apply)
                        }}
                        onClear={() => {
                          setBusy(true)
                          void api.openrouter.clearKey().then(apply)
                        }}
                      />
                    </Field>
                    <Setting title="Runs through" hint="The CLI that executes OpenRouter models.">
                      <SegmentedControl
                        label="OpenRouter agent"
                        options={OPENROUTER_AGENT_OPTIONS}
                        value={orAgent}
                        onChange={(next) => onSettings(withOpenRouterAgent(settings, next))}
                        style={{ width: 180 }}
                      />
                    </Setting>
                  </Card>
                </Group>

                {configured && (
                  <Group
                    title="Pinned models"
                    count={`${pinned.size} pinned`}
                    foot="Chat and pipelines list these under OpenRouter."
                    aside={
                      <>
                        <StatusText busy={busy} error={error} />
                        <RefreshButton
                          title="Refresh catalog"
                          disabled={busy}
                          onClick={() => {
                            setBusy(true)
                            void api.openrouter.refresh().then(apply)
                          }}
                        />
                      </>
                    }
                  >
                    <Card clip>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px' }}>
                        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke={C.faint} strokeWidth="1.4">
                          <circle cx="6" cy="6" r="4.2" />
                          <path d="m9.2 9.2 3 3" />
                        </svg>
                        <input
                          className="bf-focus"
                          aria-label="Filter catalog"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder="Filter catalog…"
                          spellCheck={false}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            padding: '4px 0',
                            border: 'none',
                            background: 'transparent',
                            color: C.text,
                            fontSize: 12.5,
                            outline: 'none'
                          }}
                        />
                      </div>
                      <div style={{ maxHeight: 380, overflow: 'auto' }}>
                        {!catalog.length && (
                          <div style={{ padding: 14, fontSize: 12.5, color: C.faint }}>
                            {error ? 'Catalog unavailable.' : 'No tool-capable models yet. Refresh after saving a key.'}
                          </div>
                        )}
                        {!!catalog.length && !visible.length && (
                          <div style={{ padding: 14, fontSize: 12.5, color: C.faint }}>No models match “{query}”.</div>
                        )}
                        {visible.map((m, i) => (
                          <Checkbox
                            key={m.id}
                            checked={pinned.has(m.id)}
                            onChange={(on) => {
                              const current = or?.pinned ?? []
                              const next = on ? [...current, m.id] : current.filter((id) => id !== m.id)
                              void api.openrouter.setPinned(next).then(apply)
                            }}
                            title={m.id}
                            style={{
                              gap: 10,
                              padding: '7px 14px',
                              fontSize: 12.5,
                              color: C.text,
                              borderTop: i ? `1px solid ${C.hair}` : undefined
                            }}
                          >
                            <span style={{ flex: 'none' }}>{m.label}</span>
                            <span
                              style={{
                                flex: 1,
                                minWidth: 0,
                                fontFamily: mono,
                                fontSize: 11.5,
                                color: C.faint,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis'
                              }}
                            >
                              {m.id}
                            </span>
                          </Checkbox>
                        ))}
                      </div>
                    </Card>
                  </Group>
                )}
              </>
            )}

            {page === 'keys' && <ProviderKeysSection settings={settings} onSettings={onSettings} onAdoptSettings={onAdoptSettings} />}
            {page === 'jev' && <JevSection settings={settings} onAdoptSettings={onAdoptSettings} />}
            {page === 'usage' && <UsageSection />}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
