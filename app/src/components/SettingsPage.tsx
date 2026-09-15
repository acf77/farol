import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { AI_LABELS, pickerProviders, providerModels, type AiProvider } from '@shared/ai'
import { OPENROUTER_API_URL } from '@shared/openrouter'
import { withAgentModel, withCommitMessageModel } from '@shared/settings'
import { C, UI } from '../theme'
import { Button, Checkbox, CliModelDropdown, SegmentedControl } from './controls'

interface Props {
  settings: AppSettings
  onSettings: (next: AppSettings) => void
  onOpenRouterSettings: (next: AppSettings) => void
  onClose: () => void
}

type TabKey = 'general' | 'models'

const TABS: readonly { value: TabKey; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'models', label: 'Models' }
]

const field: React.CSSProperties = {
  height: 28,
  padding: '0 8px',
  borderRadius: 7,
  border: `1px solid ${C.border}`,
  background: C.card,
  color: C.text,
  fontSize: 12.5
}

function Section({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: hint ? 4 : 8 }}>{title}</div>
      {hint && <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 10 }}>{hint}</div>}
      {children}
    </section>
  )
}

/** One `<agent> → default model` row. An empty value leaves it to the CLI. */
function ModelRow({
  provider,
  settings,
  onChange
}: {
  provider: AiProvider
  settings: AppSettings
  onChange: (model?: string) => void
}) {
  const current = settings.models[provider]
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ width: 96, flex: 'none', fontSize: 12, color: C.textSoft }}>
        {AI_LABELS[provider]}
      </span>
      <select
        className="bf-input bf-focus"
        value={current ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        style={{ ...field, flex: 1, minWidth: 0 }}
      >
        <option value="">Default — the CLI decides</option>
        {providerModels(provider, current, settings.openrouter).map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export default function SettingsPage({ settings, onSettings, onOpenRouterSettings, onClose }: Props) {
  const api = window.farol
  const or = settings.openrouter
  const configured = !!or?.hasKey
  const [tab, setTab] = useState<TabKey>('general')
  const [draft, setDraft] = useState('')
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

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

  const retried = useRef(false)
  useEffect(() => {
    if (retried.current || !configured || or?.autoPinned) return
    retried.current = true
    setBusy(true)
    void api.openrouter.refresh().then((result) => {
      onOpenRouterSettings(result.settings)
      setError(result.error ?? null)
      setBusy(false)
    })
  }, [api.openrouter, configured, onOpenRouterSettings, or?.autoPinned])

  const apply = (result: { settings: AppSettings; error?: string }, clearDraft = false): void => {
    onOpenRouterSettings(result.settings)
    setError(result.error ?? null)
    if (clearDraft && !result.error) {
      setDraft('')
      setReplace(false)
    }
    setBusy(false)
  }

  const providers = pickerProviders(or)
  const catalog = or?.catalog ?? []
  const pinned = new Set(or?.pinned ?? [])
  const q = query.trim().toLowerCase()
  const visible = q
    ? catalog.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(q))
    : catalog

  return (
    <div
      role="dialog"
      aria-label="Settings"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        display: 'flex',
        flexDirection: 'column',
        background: C.appBg,
        color: C.text,
        fontFamily: UI
      }}
    >
      <div
        style={{
          height: 52,
          flex: 'none',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
          alignItems: 'center',
          padding: '0 16px',
          borderBottom: `1px solid ${C.border}`
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>Settings</span>
        <SegmentedControl
          label="Settings section"
          options={TABS}
          value={tab}
          onChange={setTab}
          style={{ width: 180 }}
        />
        <div style={{ justifySelf: 'end' }}>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '24px 16px' }}>
        <div
          style={{
            maxWidth: 520,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 16
          }}
        >
          {tab === 'general' ? (
            <>
              <Section title="Agent" hint="Starts new chats and picks up failures sent from a run.">
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
              </Section>

              <Section title="Failures">
                <Checkbox
                  checked={settings.autoFix}
                  onChange={(autoFix) => onSettings({ ...settings, autoFix })}
                  style={{ fontSize: 12, color: C.textSoft }}
                >
                  Send a failed step&apos;s report straight to Chat
                </Checkbox>
              </Section>
            </>
          ) : (
            <>
              <Section
                title="Default model"
                hint="Each agent starts new chats with the model picked here. Pipeline steps keep their own."
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {providers.map((p) => (
                    <ModelRow
                      key={p}
                      provider={p}
                      settings={settings}
                      onChange={(model) => onSettings(withAgentModel(settings, p, model))}
                    />
                  ))}
                </div>
              </Section>

              <Section
                title="Commit message generator"
                hint="Used only when Git drafts a commit message. It does not follow the chat default."
              >
                <CliModelDropdown
                  label="Commit message provider and model"
                  provider={settings.commitMessage.agent}
                  model={settings.commitMessage.model}
                  settings={settings}
                  onChange={(agent, model) => onSettings(withCommitMessageModel(settings, agent, model))}
                />
              </Section>

              <Section
                title="OpenRouter"
                hint={`Endpoint ${OPENROUTER_API_URL} · runs through OpenCode`}
              >
                {configured && !replace ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: 12.5, color: C.textSoft }}>API key saved</span>
                    <Button variant="ghost" onClick={() => setReplace(true)}>
                      Replace
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        setBusy(true)
                        void api.openrouter.clearKey().then((result) => apply(result, true))
                      }}
                    >
                      Clear
                    </Button>
                  </div>
                ) : (
                  <form
                    style={{ display: 'flex', gap: 8, marginBottom: 10 }}
                    onSubmit={(e) => {
                      e.preventDefault()
                      setBusy(true)
                      void api.openrouter.saveKey(draft).then((result) => apply(result, true))
                    }}
                  >
                    <input
                      className="bf-input bf-focus"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="sk-or-…"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      style={{ ...field, flex: 1 }}
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
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Button
                    variant="secondary"
                    disabled={busy || !configured}
                    onClick={() => {
                      setBusy(true)
                      void api.openrouter.refresh().then((result) => apply(result))
                    }}
                  >
                    Refresh catalog
                  </Button>
                  {busy && <span style={{ fontSize: 11.5, color: C.textMuted }}>Working…</span>}
                </div>
                {error && <div style={{ fontSize: 12, color: C.red, marginBottom: 8 }}>{error}</div>}
              </Section>

              {configured && (
                <Section title="Pinned models" hint="Chat and pipelines list these under OpenRouter.">
                  <input
                    className="bf-input bf-focus"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter catalog…"
                    spellCheck={false}
                    style={{ ...field, width: '100%', marginBottom: 10 }}
                  />
                  {!catalog.length && (
                    <div style={{ fontSize: 12, color: C.textMuted }}>
                      {error
                        ? 'Catalog unavailable.'
                        : 'No tool-capable models yet. Refresh after saving a key.'}
                    </div>
                  )}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      maxHeight: 360,
                      overflow: 'auto'
                    }}
                  >
                    {visible.map((m) => (
                      <Checkbox
                        key={m.id}
                        checked={pinned.has(m.id)}
                        onChange={(on) => {
                          const current = or?.pinned ?? []
                          const next = on
                            ? [...current, m.id]
                            : current.filter((id) => id !== m.id)
                          void api.openrouter.setPinned(next).then((result) => apply(result))
                        }}
                        title={m.id}
                        style={{ fontSize: 12, color: C.textSoft }}
                      >
                        <span>
                          {m.label}
                          <span style={{ color: C.faint, marginLeft: 6 }}>{m.id}</span>
                        </span>
                      </Checkbox>
                    ))}
                  </div>
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
