import { Component, type ErrorInfo, type ReactNode } from 'react'
import { C, UI } from './theme'

interface Props {
  children: ReactNode
  /** Compact inline fallback for a single chat message or pane. */
  compact?: boolean
  onReset?: () => void
}

interface State {
  error: Error | null
}

function fallbackUi(
  compact: boolean,
  onReload: () => void,
  onReset?: () => void
): ReactNode {
  if (compact) {
    return (
      <div
        style={{
          marginLeft: 41,
          padding: '8px 12px',
          borderRadius: 9,
          background: '#111827',
          border: '1px solid #273449',
          fontSize: 12.5,
          lineHeight: 1.45,
          color: C.textMuted
        }}
      >
        Could not render this message.
        {onReset ? (
          <button
            type="button"
            className="bf-focus"
            onClick={onReset}
            style={{
              marginLeft: 8,
              border: 'none',
              background: 'transparent',
              color: C.accentBright,
              cursor: 'pointer',
              fontSize: 'inherit',
              padding: 0
            }}
          >
            Retry
          </button>
        ) : null}
      </div>
    )
  }
  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 32,
        boxSizing: 'border-box',
        background: '#080D17',
        color: C.text,
        fontFamily: UI,
        fontSize: 14,
        textAlign: 'center'
      }}
    >
      <div style={{ fontSize: 17, fontWeight: 600, color: C.textSoft }}>Farol hit an error</div>
      <div style={{ maxWidth: 480, lineHeight: 1.5, color: C.textMuted }}>
        The workspace stopped updating. Your terminals and agent processes may still be running in the
        background.
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
        {onReset ? (
          <button
            type="button"
            className="bf-focus"
            onClick={onReset}
            style={{
              border: '1px solid #273449',
              borderRadius: 9,
              padding: '10px 18px',
              background: 'transparent',
              color: C.textSoft,
              fontSize: 13.5,
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            Try again
          </button>
        ) : null}
        <button
          type="button"
          className="bf-focus"
          onClick={onReload}
          style={{
            border: 'none',
            borderRadius: 9,
            padding: '10px 18px',
            background: C.accent,
            color: '#fff',
            fontSize: 13.5,
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          Reload workspace
        </button>
      </div>
    </div>
  )
}

/**
 * Agent and pipeline streams can throw during render or in a batched state flush.
 * Without a boundary the whole renderer tree unmounts and the window goes blank.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[farol] UI error', error, info.componentStack)
  }

  private reset = (): void => {
    this.setState({ error: null })
    this.props.onReset?.()
  }

  render(): ReactNode {
    if (this.state.error) {
      return fallbackUi(!!this.props.compact, () => window.location.reload(), this.reset)
    }
    return this.props.children
  }
}

/** Isolate one chat turn so a bad markdown chunk cannot blank the whole pane. */
export function MessageErrorBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary compact>{children}</ErrorBoundary>
}
