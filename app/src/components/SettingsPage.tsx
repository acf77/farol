import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentMode, AppSettings, ModelChoice, RemoteResult, SettingsResult } from '@shared/types'
import {
  AI_LABELS,
  normalizeOpenRouterAgent,
  OPENROUTER_AGENT_LABELS,
  OPENROUTER_AGENTS,
  pickerProviders,
  type AiProvider
} from '@shared/ai'
import { AI_GATEWAY_API_URL, errorMessage, JEV_MODEL_ID } from '@shared/jev'
import { OPENROUTER_API_URL } from '@shared/openrouter'
import {
  withAgentModel,
  withCommitMessageModel,
  withModeChain,
  withOpenRouterAgent
} from '@shared/settings'
import { C, MONO, UI } from '../theme'
import { Button, Checkbox, CliModelDropdown, SegmentedControl } from './controls'
import { ChevronDown, ChevronUp } from './icons'
import { CHROME_ROW } from './side-panel'

interface Props {
  settings: AppSettings
  onSettings: (next: AppSettings) => void
  /** Adopt settings the main process already owns — provider keys, catalogs. */
  onAdoptSettings: (next: AppSettings) => void
  onClose: () => void
}

type TabKey = 'general' | 'models'

const TABS: readonly { value: TabKey; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'models', label: 'Models' }
]

const OPENROUTER_AGENT_OPTIONS = OPENROUTER_AGENTS.map((value) => ({
  value,
  label: OPENROUTER_AGENT_LABELS[value]
}))

const card: React.CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: 12,
  background: C.sidebar,
  padding: 16,
  minWidth: 0
}

const field: React.CSSProperties = {
  height: 28,
  padding: '0 8px',
  borderRadius: 6,
  border: `1px solid ${C.border}`,
  background: C.terminal,
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: C.textSoft }}>API key saved</span>
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
      style={{ display: 'flex', gap: 8, marginBottom: 10 }}
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
    <Section
      title="Jev"
      hint={`${JEV_MODEL_ID} via ${AI_GATEWAY_API_URL} — Farol's internal decisions only. Jev writes no text, so it is not offered to Chat or to pipeline steps.`}
    >
      <ApiKeyField
        configured={configured}
        placeholder="vck_…"
        busy={busy}
        onSave={(key) => run(api.jev.saveKey(key))}
        onClear={() => void run(api.jev.clearKey())}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Button
          variant="secondary"
          disabled={busy || !configured}
          onClick={() => void run(api.jev.check())}
        >
          Test
        </Button>
        {busy && <span style={{ fontSize: 11, color: C.textMuted }}>Working…</span>}
        {!busy && configured && probed && !error && (
          <span style={{ fontSize: 11, color: C.textSoft }}>
            Jev answered the check question.
          </span>
        )}
      </div>
      {error && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{error}</div>}
    </Section>
  )
}

/**
 * Remote pipelines run their shell steps in a sandbox on a Farol service. Signing
 * in with GitHub stores a session token where an API key would go, encrypted on
 * this machine; the URL is a plain setting.
 */
function RemoteSection({
  settings,
  onAdoptSettings
}: {
  settings: AppSettings
  onAdoptSettings: (next: AppSettings) => void
}) {
  const api = window.farol
  const saved = settings.remote
  const [url, setUrl] = useState(saved?.url ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [probed, setProbed] = useState(false)
  const [account, setAccount] = useState<string | null>(null)
  const [userCode, setUserCode] = useState<string | null>(null)
  const hasKey = !!saved?.hasKey
  const urlChanged = url.trim() !== (saved?.url ?? '')

  const run = (call: Promise<RemoteResult>, probe = false): Promise<boolean> => {
    setBusy(true)
    return call
      .then((result) => {
        onAdoptSettings(result.settings)
        if (result.settings.remote) setUrl(result.settings.remote.url)
        setError(result.error ?? null)
        setProbed(probe && !result.error)
        if (result.account) setAccount(result.account)
        if (!result.settings.remote?.hasKey) setAccount(null)
        return !result.error
      })
      .catch((err: unknown) => {
        setError(errorMessage(err))
        return false
      })
      .finally(() => setBusy(false))
  }

  const signIn = async (): Promise<void> => {
    setError(null)
    const start = await api.remote.signInStart()
    if ('error' in start) return setError(start.error)
    setUserCode(start.userCode)
    await run(api.remote.signInWait())
    setUserCode(null)
  }

  return (
    <Section
      title="Remote service"
      hint="Pipelines set to run remotely execute their shell steps in a fresh sandbox on your Farol service, holding a snapshot of the current checkout, uncommitted work included. Ignored and secret-looking files stay behind. AI steps still run on this machine, so later remote steps do not see edits they make."
    >
      <ApiKeyField
        configured={hasKey}
        placeholder="Or an API key (frl_…)"
        busy={busy}
        onSave={(key) => run(api.remote.save({ url: url || saved?.url || '', key }))}
        onClear={() => void run(api.remote.clearKey())}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          className="bf-input bf-focus"
          spellCheck={false}
          placeholder="https://your-service.up.railway.app"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ ...field, flex: 1 }}
        />
        {(urlChanged || !saved) && (
          <Button variant="primary" disabled={busy || !url.trim()} onClick={() => void run(api.remote.save({ url }))}>
            Save
          </Button>
        )}
        <Button variant="secondary" disabled={busy || !saved || urlChanged} onClick={() => void run(api.remote.check(), true)}>
          Test
        </Button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        {userCode ? (
          <>
            <span style={{ fontSize: 12, color: C.textSoft, flex: 1 }}>
              Enter <strong style={{ fontFamily: MONO }}>{userCode}</strong> on the GitHub page that
              opened.
            </span>
            <Button variant="secondary" onClick={() => void api.remote.signInCancel()}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <span style={{ fontSize: 12, color: C.textSoft, flex: 1 }}>
              {account ? `Signed in as ${account}` : hasKey ? 'Token stored' : 'Not signed in'}
            </span>
            <Button variant="primary" disabled={busy || !saved || urlChanged} onClick={() => void signIn()}>
              {hasKey ? 'Sign in again' : 'Sign in with GitHub'}
            </Button>
          </>
        )}
      </div>
      {busy && !userCode && <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 8 }}>Working…</div>}
      {!busy && saved && probed && !error && !urlChanged && (
        <div style={{ fontSize: 11.5, color: C.textSoft, marginTop: 8 }}>Remote service is ready.</div>
      )}
      {error && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{error}</div>}
    </Section>
  )
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
    <section style={card}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: hint ? 4 : 10 }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.45, marginBottom: 14 }}>{hint}</div>}
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
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ width: 96, flex: 'none', fontSize: 12, color: C.textSoft }}>
        {AI_LABELS[provider]}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <CliModelDropdown
          label={`${AI_LABELS[provider]} default model`}
          provider={provider}
          model={settings.models[provider]}
          settings={settings}
          locked
          onChange={(_agent, model) => onChange(model)}
        />
      </div>
    </label>
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
  mode: AgentMode
  settings: AppSettings
  onSettings: (next: AppSettings) => void
}) {
  const chain = settings.modeDefaults[mode]
  const save = (next: ModelChoice[]): void => onSettings(withModeChain(settings, mode, next))
  const move = (from: number, to: number): void => {
    const next = [...chain]
    const [rung] = next.splice(from, 1)
    next.splice(to, 0, rung)
    save(next)
  }
  const fallback = pickerProviders(settings.openrouter)[0]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {chain.map((rung, i) => (
        <div key={`${rung.agent}:${rung.model ?? ''}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 18, flex: 'none', fontSize: 11, color: C.faint }}>{i + 1}.</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <CliModelDropdown
              label={`${mode === 'plan' ? 'Plan' : 'Build'} model ${i + 1}`}
              provider={rung.agent}
              model={rung.model}
              settings={settings}
              onChange={(agent, model) =>
                save(chain.map((r, at) => (at === i ? { agent, ...(model ? { model } : {}) } : r)))
              }
            />
          </div>
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
      ))}
      <div>
        <Button
          variant="secondary"
          disabled={!fallback}
          onClick={() => fallback && save([...chain, { agent: fallback }])}
        >
          {chain.length ? 'Add fallback' : 'Add model'}
        </Button>
      </div>
    </div>
  )
}

export default function SettingsPage({ settings, onSettings, onAdoptSettings, onClose }: Props) {
  const api = window.farol
  const or = settings.openrouter
  const configured = !!or?.hasKey
  const orAgent = normalizeOpenRouterAgent(or?.agent)
  const [tab, setTab] = useState<TabKey>('general')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [listsHint, setListsHint] = useState<string | null>(null)
  const listsRefreshed = useRef(false)

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
    if (tab !== 'models' || listsRefreshed.current) return
    listsRefreshed.current = true
    refreshLists()
  }, [tab])

  const providers = pickerProviders(or)
  const catalog = or?.catalog ?? []
  const pinned = new Set(or?.pinned ?? [])
  const q = query.trim().toLowerCase()
  const visible = q
    ? catalog.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(q))
    : catalog

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
        background: C.terminal,
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
        {tab === 'general' ? (
          <div
            style={{
              maxWidth: 620,
              margin: '0 auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 14
            }}
          >
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

            <JevSection settings={settings} onAdoptSettings={onAdoptSettings} />

            <RemoteSection settings={settings} onAdoptSettings={onAdoptSettings} />
          </div>
        ) : (
          <div
            style={{
              maxWidth: 900,
              margin: '0 auto',
              display: 'grid',
              gridTemplateColumns: configured ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)',
              gap: 14,
              alignItems: 'start'
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
              <Section
                title="Default model"
                hint="Each agent starts new chats with the model picked here. Pipeline steps keep their own. Lists refresh from the installed CLIs."
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
                  <Button variant="secondary" disabled={busy} onClick={refreshLists}>
                    Refresh model lists
                  </Button>
                  {busy && <span style={{ fontSize: 11, color: C.textMuted }}>Working…</span>}
                  {!busy && listsHint && (
                    <span style={{ fontSize: 11, color: listsHint === 'Updated' ? C.textSoft : C.red }}>
                      {listsHint}
                    </span>
                  )}
                </div>
              </Section>

              <Section
                title="Build mode"
                hint="New chats start on the first model. If it fails — CLI missing, non-zero exit, usage or quota limit — Farol retries the same turn on the next one down."
              >
                <ModeChain mode="build" settings={settings} onSettings={onSettings} />
              </Section>

              <Section
                title="Plan mode"
                hint="Leave empty to keep whichever model the chat is already on."
              >
                <ModeChain mode="plan" settings={settings} onSettings={onSettings} />
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
                hint={`Endpoint ${OPENROUTER_API_URL} · runs through ${OPENROUTER_AGENT_LABELS[orAgent]}`}
              >
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

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: C.textSoft }}>Runs through</span>
                  <SegmentedControl
                    label="OpenRouter agent"
                    options={OPENROUTER_AGENT_OPTIONS}
                    value={orAgent}
                    onChange={(next) => onSettings(withOpenRouterAgent(settings, next))}
                    style={{ width: 180 }}
                  />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Button
                    variant="secondary"
                    disabled={busy || !configured}
                    onClick={() => {
                      setBusy(true)
                      void api.openrouter.refresh().then(apply)
                    }}
                  >
                    Refresh catalog
                  </Button>
                  {busy && <span style={{ fontSize: 11, color: C.textMuted }}>Working…</span>}
                </div>
                {error && <div style={{ fontSize: 12, color: C.red, marginBottom: 8 }}>{error}</div>}
              </Section>
            </div>

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
                        void api.openrouter.setPinned(next).then(apply)
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
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
