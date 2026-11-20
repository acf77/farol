import { C } from '../../theme'

/** What each button asks the agent to do; the agent answers with a FAROL_GIT line that Farol runs. */
export const GIT_REQUESTS = [
  { label: 'Commit', prompt: 'Commit the changes of this chat with a clear message.' },
  { label: 'Push', prompt: 'Push the current branch.' },
  { label: 'Create PR', prompt: 'Create a pull request for the current branch.' }
] as const

/** Small buttons at the top of Chat that ask the agent for a Git action. Shown only while the Git actions switch is on. */
export function GitBar({ disabled, onRequest }: { disabled: boolean; onRequest: (prompt: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '8px 12px 0', justifyContent: 'center' }}>
      {GIT_REQUESTS.map(({ label, prompt }) => (
        <button
          key={label}
          type="button"
          className="bf-focus bf-pill"
          disabled={disabled}
          title={prompt}
          onClick={() => onRequest(prompt)}
          style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 13px', borderRadius: 20, border: '1px solid oklch(1 0 0 / 0.09)', background: 'transparent', font: 'inherit', fontSize: 12.5, color: C.textRow, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}
        >
          <span style={{ width: 6, height: 6, flex: 'none', borderRadius: '50%', background: C.accent }} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}
