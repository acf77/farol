import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { OPENROUTER_API_URL } from '@shared/openrouter'
import { C, UI } from '../theme'
import { Button, Checkbox } from './controls'

interface Props {
  settings: AppSettings
  onSettings: (next: AppSettings) => void
  onClose: () => void
}

export default function SettingsPage({ settings, onSettings, onClose }: Props) {
  const api = window.farol
  const or = settings.openrouter
  const configured = !!or?.hasKey
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
      onSettings(result.settings)
      setError(result.error ?? null)
      setBusy(false)
    })
  }, [api.openrouter, configured, or?.autoPinned, onSettings])

  const apply = (result: { settings: AppSettings; error?: string }, clearDraft = false): void => {
    onSettings(result.settings)
    setError(result.error ?? null)
    if (clearDraft && !result.error) {
      setDraft('')
      setReplace(false)
    }
    setBusy(false)
  }

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
        background: '#080D17',
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
          justifyContent: 'space-between',
          padding: '0 16px',
          borderBottom: `1px solid ${C.border}`
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>Settings</span>
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '24px 16px' }}>
        <div style={{ maxWidth: 520, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>OpenRouter</div>
            <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 10 }}>
              Endpoint {OPENROUTER_API_URL} · runs through OpenCode
            </div>

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
                  style={{
                    flex: 1,
                    height: 28,
                    padding: '0 8px',
                    borderRadius: 7,
                    border: `1px solid ${C.border}`,
                    background: C.card,
                    color: C.text,
                    fontSize: 12.5
                  }}
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
          </section>

          {configured && (
            <section>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                Pinned models
                <span style={{ fontWeight: 400, color: C.textMuted }}>
                  {' '}
                  — Chat and pipelines list these
                </span>
              </div>
              <input
                className="bf-input bf-focus"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter catalog…"
                spellCheck={false}
                style={{
                  width: '100%',
                  height: 28,
                  padding: '0 8px',
                  borderRadius: 7,
                  border: `1px solid ${C.border}`,
                  background: C.card,
                  color: C.text,
                  fontSize: 12.5,
                  marginBottom: 10
                }}
              />
              {!catalog.length && (
                <div style={{ fontSize: 12, color: C.textMuted }}>
                  {error ? 'Catalog unavailable.' : 'No tool-capable models yet. Refresh after saving a key.'}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 360, overflow: 'auto' }}>
                {visible.map((m) => (
                  <Checkbox
                    key={m.id}
                    checked={pinned.has(m.id)}
                    onChange={(on) => {
                      const current = or?.pinned ?? []
                      const next = on ? [...current, m.id] : current.filter((id) => id !== m.id)
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
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
