import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentScanResult } from '@shared/types'
import { AI_LABELS, type AiProvider } from '@shared/ai'
import type { AppSettings } from '@shared/settings'
import { C, UI, MONO } from '../theme'
import { Button } from './controls'
import { REMOTE_ENABLED } from '@shared/features'
import { remoteAccount, useRemoteAccount } from '../remote-account'
import farolMark from '../assets/farol-mark.png'

type Step = 'welcome' | 'agents'

interface AgentRow {
  provider: AiProvider
  install: string
}

/** Order and install hints mirror the Onboarding design: three main agents, then the rest. */
const MAIN: AgentRow[] = [
  { provider: 'claude', install: 'npm i -g @anthropic-ai/claude-code' },
  { provider: 'codex', install: 'npm i -g @openai/codex' },
  { provider: 'opencode', install: 'brew install opencode' }
]
const OTHERS: AgentRow[] = [
  { provider: 'cursor', install: 'curl https://cursor.com/install -fsS | bash' },
  { provider: 'omp', install: 'npm i -g omp-cli' }
]
const ALL = [...MAIN, ...OTHERS]

const AMBER = 'oklch(0.8 0.12 75)'
const HAIR = 'oklch(1 0 0 / 0.08)'

const LOGOS: Partial<Record<AiProvider, { path: string; evenOdd?: boolean }>> = {
  claude: {
    path: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'
  },
  codex: {
    evenOdd: true,
    path: 'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z'
  },
  opencode: { path: 'M22 24H2V0h20zM17 4.8H7v14.4h10z' },
  cursor: {
    path: 'M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23'
  }
}

function AgentLogo({ provider }: { provider: AiProvider }) {
  const logo = LOGOS[provider]
  return (
    <div
      aria-hidden
      style={{
        width: 44,
        height: 44,
        flex: 'none',
        borderRadius: 11,
        display: 'grid',
        placeItems: 'center',
        background: 'oklch(0.19 0.004 95)',
        border: `1px solid ${HAIR}`,
        color: '#cfcfca'
      }}
    >
      {logo ? (
        <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
          <path d={logo.path} fillRule={logo.evenOdd ? 'evenodd' : undefined} />
        </svg>
      ) : (
        <span style={{ fontSize: 12, fontWeight: 600 }}>{AI_LABELS[provider].slice(0, 3)}</span>
      )}
    </div>
  )
}

function Check({ size = 12, color = C.green }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth="1.6" aria-hidden>
      <path d="M2.5 6.2 5 8.5l4.5-5" />
    </svg>
  )
}

function Status({ found }: { found: boolean }) {
  const color = found ? C.green : AMBER
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 500, color }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: color }} />
      {found ? 'Installed' : 'Not installed'}
    </span>
  )
}

function CopyInstall({ command, compact }: { command: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className="bf-focus"
      title="Copy install command"
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard?.writeText(command).catch(() => {})
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1400)
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: compact ? '6px 9px' : '5px 10px',
        maxWidth: compact ? undefined : 240,
        minWidth: 0,
        borderRadius: 7,
        background: 'oklch(0.19 0.004 95)',
        border: '1px solid oklch(1 0 0 / 0.09)',
        fontFamily: MONO,
        fontSize: compact ? 11 : 11.5,
        color: C.textRow,
        cursor: 'pointer',
        textAlign: 'left'
      }}
    >
      <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {command}
      </span>
      <span style={{ flex: 'none', fontFamily: UI, fontSize: 11, color: C.faint }}>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )
}

function DefaultButton({ isDefault, onClick }: { isDefault: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={isDefault ? undefined : 'bf-focus bf-hover-fill'}
      disabled={isDefault}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      style={{
        flex: 'none',
        whiteSpace: 'nowrap',
        textAlign: 'center',
        padding: '5px 11px',
        borderRadius: 7,
        fontSize: 12,
        fontWeight: 500,
        fontFamily: UI,
        ...(isDefault
          ? { color: C.faint, background: 'transparent', border: 'none', cursor: 'default' }
          : { color: C.textSoft, background: C.panel, border: `1px solid ${C.hair}`, cursor: 'pointer' })
      }}
    >
      {isDefault ? 'Default' : 'Make default'}
    </button>
  )
}

const heading: React.CSSProperties = { fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }
const lede: React.CSSProperties = { fontSize: 13, lineHeight: 1.55, color: C.textMuted, textWrap: 'pretty' }
const sectionLabel: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: C.faint }

function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className="bf-focus bf-hover-fill"
      aria-label="Copy code"
      onClick={() => {
        void navigator.clipboard?.writeText(code).catch(() => {})
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1400)
      }}
      style={{
        flex: 'none',
        minWidth: 52,
        padding: '4px 9px',
        borderRadius: 7,
        border: `1px solid ${C.hair}`,
        background: C.panel,
        color: C.textSoft,
        fontFamily: UI,
        fontSize: 12,
        cursor: 'pointer'
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function Welcome({ onNext }: { onNext: () => void }) {
  const { account, busy, userCode, error } = useRemoteAccount()
  useEffect(() => remoteAccount.refresh(), [])
  const signedIn = account?.state === 'signedIn' ? account : null
  const waiting = busy && !signedIn
  const name = signedIn ? signedIn.displayName || signedIn.login : ''
  return (
    <div
      style={{
        margin: 'auto',
        width: '100%',
        maxWidth: 400,
        padding: '24px 28px 72px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 28,
        textAlign: 'center'
      }}
    >
      <img src={farolMark} alt="Farol" width={64} height={64} draggable={false} style={{ display: 'block', borderRadius: 15 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h1 style={{ ...heading, margin: 0 }}>Welcome to Farol</h1>
        <span style={lede}>Sign in with GitHub to get started.</span>
      </div>

      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!signedIn && !waiting && (
          <>
            <button
              type="button"
              className="bf-focus"
              onClick={() => void remoteAccount.signIn()}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 9,
                height: 38,
                borderRadius: 9,
                border: 'none',
                background: C.text,
                color: C.app,
                fontFamily: UI,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
              Continue with GitHub
            </button>
            {error && (
              <span role="alert" style={{ fontSize: 12, color: C.red }}>
                {error}
              </span>
            )}
          </>
        )}

        {waiting && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              padding: '14px 16px',
              borderRadius: 12,
              background: C.sidebar,
              border: `1px solid ${HAIR}`,
              textAlign: 'left'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  animation: 'bfspin .8s linear infinite',
                  width: 12,
                  height: 12,
                  flex: 'none',
                  borderRadius: '50%',
                  border: '1.5px solid oklch(1 0 0 / 0.15)',
                  borderTopColor: C.accent
                }}
              />
              <span style={{ flex: 1 }}>Waiting for GitHub in your browser</span>
              <button
                type="button"
                className="bf-focus"
                onClick={() => remoteAccount.cancelSignIn()}
                style={{ border: 'none', background: 'none', fontFamily: UI, fontSize: 12, color: C.textMuted, cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
            {userCode && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  paddingTop: 12,
                  borderTop: '1px solid oklch(1 0 0 / 0.06)'
                }}
              >
                <span style={{ flex: 1, fontSize: 12, color: 'oklch(0.62 0.006 95)' }}>
                  Enter this code on github.com/login/device
                </span>
                <span style={{ fontFamily: MONO, fontSize: 14, letterSpacing: '0.08em', userSelect: 'all' }}>{userCode}</span>
                <CopyCode code={userCode} />
              </div>
            )}
          </div>
        )}

        {signedIn && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 14px',
                borderRadius: 12,
                background: C.sidebar,
                border: `1px solid ${HAIR}`,
                textAlign: 'left'
              }}
            >
              {signedIn.avatar ? (
                <img src={signedIn.avatar} alt="" width={32} height={32} style={{ flex: 'none', borderRadius: '50%' }} />
              ) : (
                <div
                  style={{
                    width: 32,
                    height: 32,
                    flex: 'none',
                    borderRadius: '50%',
                    background: 'oklch(0.32 0.006 95)',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'oklch(0.85 0.006 95)'
                  }}
                >
                  {name.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{signedIn.login}</span>
                <span style={{ fontSize: 12, color: 'oklch(0.62 0.006 95)' }}>Signed in</span>
              </div>
              <Check size={13} />
            </div>
            <Button variant="primary" onClick={onNext} style={{ height: 38, borderRadius: 9, fontSize: 13 }}>
              Continue
            </Button>
          </div>
        )}

        {!signedIn && !waiting && (
          <button
            type="button"
            className="bf-focus"
            onClick={onNext}
            style={{ border: 'none', background: 'none', fontFamily: UI, fontSize: 12, color: 'oklch(0.62 0.006 95)', cursor: 'pointer' }}
          >
            Continue without an account
          </button>
        )}
      </div>
    </div>
  )
}

function Agents({
  settings,
  onBack,
  onFinish
}: {
  settings: AppSettings
  onBack?: () => void
  onFinish: (next: AppSettings) => void
}) {
  const [scan, setScan] = useState<AgentScanResult[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [on, setOn] = useState<Set<AiProvider>>(() => new Set())
  const [chosenDefault, setChosenDefault] = useState<AiProvider>(settings.agent)
  const seeded = useRef(false)

  const rescan = useCallback(() => {
    setScanning(true)
    void window.farol.agents
      .scan()
      .then((result) => {
        setScan(result)
        // First scan switches on everything found; a rescan only drops what vanished.
        setOn((prev) => {
          const found = new Set(result.filter((r) => r.found).map((r) => r.provider))
          if (!seeded.current) {
            seeded.current = true
            return found
          }
          return new Set([...prev].filter((p) => found.has(p)))
        })
      })
      .catch(() => setScan([]))
      .finally(() => setScanning(false))
  }, [])
  useEffect(rescan, [rescan])

  const info = (p: AiProvider) => scan?.find((r) => r.provider === p)
  const isFound = (p: AiProvider) => info(p)?.found === true
  const enabled = ALL.map((a) => a.provider).filter((p) => isFound(p) && on.has(p))
  const def = enabled.includes(chosenDefault) ? chosenDefault : enabled[0]
  const ready = enabled.length > 0 && def !== undefined

  const toggle = (p: AiProvider) => {
    if (!isFound(p)) return
    setOn((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }
  const makeDefault = (p: AiProvider) => {
    setChosenDefault(p)
    setOn((prev) => new Set(prev).add(p))
  }
  const finish = () => {
    if (!ready) return
    onFinish({ ...settings, agent: def, enabledAgents: enabled, onboarded: true })
  }

  return (
    <div
      style={{
        margin: '0 auto',
        width: '100%',
        minWidth: 0,
        maxWidth: 580,
        padding: '28px 28px 64px',
        display: 'flex',
        flexDirection: 'column',
        gap: 28
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h1 style={{ ...heading, margin: 0 }}>Set up your agents</h1>
        <span style={lede}>Choose which agents Farol can use.</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...sectionLabel, whiteSpace: 'nowrap' }}>MAIN AGENTS</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="bf-focus"
            onClick={rescan}
            disabled={scanning}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              border: 'none',
              background: 'none',
              fontFamily: UI,
              fontSize: 12,
              color: C.textRow,
              cursor: scanning ? 'default' : 'pointer'
            }}
          >
            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
              <path d="M12 7a5 5 0 1 1-1.5-3.6" />
              <path d="M11 1.5v2.5H8.5" />
            </svg>
            {scanning ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10, minWidth: 0 }}>
          {MAIN.map(({ provider, install }) => {
            const found = isFound(provider)
            const checked = found && on.has(provider)
            const isDefault = checked && def === provider
            return (
              <div
                key={provider}
                role="checkbox"
                aria-checked={checked}
                aria-disabled={!found}
                aria-label={AI_LABELS[provider]}
                tabIndex={found ? 0 : -1}
                className="bf-focus"
                onClick={() => toggle(provider)}
                onKeyDown={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault()
                    toggle(provider)
                  }
                }}
                style={{
                  minWidth: 0,
                  minHeight: 164,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 14,
                  padding: 14,
                  borderRadius: 12,
                  cursor: found ? 'pointer' : 'default',
                  transition: 'border-color .15s, background .15s',
                  background: checked ? 'oklch(0.24 0.008 115)' : C.sidebar,
                  border: `1px solid ${isDefault ? 'oklch(0.91 0.19 115 / 0.55)' : checked ? 'oklch(1 0 0 / 0.14)' : HAIR}`
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, paddingTop: 6, textAlign: 'center' }}>
                  <AgentLogo provider={provider} />
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minWidth: 0, maxWidth: '100%' }}>
                    <span
                      style={{
                        maxWidth: '100%',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        fontSize: 14,
                        fontWeight: 600,
                        color: found ? C.text : C.textMuted
                      }}
                    >
                      {AI_LABELS[provider]}
                    </span>
                    {scan && found && (
                      <span style={{ fontFamily: MONO, fontSize: 11, color: C.faint }}>{info(provider)?.version ?? ''}</span>
                    )}
                    {scan && <Status found={found} />}
                  </div>
                </div>
                <span style={{ flex: 1 }} />
                {scan && found && <DefaultButton isDefault={isDefault} onClick={() => makeDefault(provider)} />}
                {scan && !found && <CopyInstall command={install} compact />}
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={sectionLabel}>OTHER AGENTS</span>
        <div style={{ borderRadius: 12, background: C.sidebar, border: `1px solid ${HAIR}` }}>
          {OTHERS.map(({ provider, install }, i) => {
            const found = isFound(provider)
            const checked = found && on.has(provider)
            const isDefault = checked && def === provider
            return (
              <div
                key={provider}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '12px 16px',
                  ...(i > 0 ? { borderTop: '1px solid oklch(1 0 0 / 0.06)' } : {})
                }}
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  aria-label={AI_LABELS[provider]}
                  disabled={!found}
                  className="bf-focus"
                  onClick={() => toggle(provider)}
                  style={{
                    width: 16,
                    height: 16,
                    padding: 0,
                    borderRadius: 4,
                    flex: 'none',
                    display: 'grid',
                    placeItems: 'center',
                    cursor: found ? 'pointer' : 'default',
                    ...(checked
                      ? { background: C.accent, border: 'none' }
                      : { background: 'transparent', border: `1px solid oklch(1 0 0 / ${found ? 0.22 : 0.1})` })
                  }}
                >
                  {checked && <Check size={9} color={C.accentInk} />}
                </button>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: found ? C.text : 'oklch(0.62 0.006 95)' }}>{AI_LABELS[provider]}</span>
                    {isDefault && (
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 600,
                          padding: '1px 6px',
                          borderRadius: 4,
                          background: 'oklch(0.91 0.19 115 / 0.14)',
                          color: C.accent
                        }}
                      >
                        DEFAULT
                      </span>
                    )}
                    {scan && <Status found={found} />}
                  </div>
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 11.5,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      color: found ? C.faint : AMBER
                    }}
                  >
                    {found ? (info(provider)?.version ?? '') : ''}
                  </span>
                </div>
                {scan && found && <DefaultButton isDefault={isDefault} onClick={() => makeDefault(provider)} />}
                {scan && !found && <CopyInstall command={install} />}
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {onBack && <Button onClick={onBack} style={{ padding: '7px 14px', height: 'auto', fontSize: 12.5 }}>
          Back
        </Button>}
        <span style={{ flex: 1 }} />
        {!ready && scan && (
          <span style={{ fontSize: 12, color: C.faint }}>Turn on at least one agent</span>
        )}
        <Button
          variant="primary"
          disabled={!ready}
          onClick={finish}
          style={{ padding: '7px 16px', height: 'auto', fontSize: 12.5, borderRadius: 7 }}
        >
          Open Farol
        </Button>
      </div>
    </div>
  )
}

/**
 * First-run setup: sign in with GitHub, then pick which coding CLIs Farol may
 * use. Both steps can be passed through — an account is optional, and only the
 * agents found on this machine can be switched on.
 */
export default function Onboarding({ settings, onFinish }: { settings: AppSettings; onFinish: (next: AppSettings) => void }) {
  const [step, setStep] = useState<Step>(REMOTE_ENABLED ? 'welcome' : 'agents')
  const stepIndex = step === 'welcome' ? 0 : 1
  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: C.app,
        color: C.text,
        fontFamily: UI,
        fontSize: 13,
        overflow: 'hidden'
      }}
    >
      <div
        style={{
          height: 52,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          WebkitAppRegion: 'drag'
        } as React.CSSProperties}
      >
        <div role="img" aria-label={`Step ${stepIndex + 1} of 2`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {[0, 1].map((i) => (
            <div
              key={i}
              style={{
                height: 6,
                borderRadius: 3,
                transition: 'all .2s',
                width: stepIndex === i ? 18 : 6,
                background: stepIndex === i ? C.text : 'oklch(1 0 0 / 0.2)'
              }}
            />
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex' }}>
        {step === 'welcome' ? (
          <Welcome onNext={() => setStep('agents')} />
        ) : (
          <Agents settings={settings} onBack={REMOTE_ENABLED ? () => setStep('welcome') : undefined} onFinish={onFinish} />
        )}
      </div>
    </div>
  )
}
