import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { MONO } from '../theme'

/**
 * A shell pane: a real terminal emulator wired straight to a PTY. xterm.js
 * owns the screen buffer, so the shell draws its own prompt and full-screen
 * programs — an interactive agent, vim, htop — work exactly as they do in the
 * user's terminal. Nothing here interprets the byte stream.
 */

const api = window.farol

/** Palette shared with the run-log renderer, so both panes look like one app. */
const THEME = {
  background: '#080D17',
  foreground: '#F8FAFC',
  cursor: '#2563EB',
  cursorAccent: '#080D17',
  selectionBackground: 'rgba(37,99,235,0.35)',
  black: '#64748B',
  red: '#EF4444',
  green: '#22C55E',
  yellow: '#F59E0B',
  blue: '#60A5FA',
  magenta: '#bf5af2',
  cyan: '#38BDF8',
  white: '#F8FAFC',
  brightBlack: '#94A3B8',
  brightRed: '#F87171',
  brightGreen: '#4ADE80',
  brightYellow: '#FBBF24',
  brightBlue: '#93C5FD',
  brightMagenta: '#d7a5f7',
  brightCyan: '#BAE6FD',
  brightWhite: '#FFFFFF'
}

interface Props {
  paneId: string
  cwd: string
  /** Tab is on screen — refit/refresh after being hidden. */
  visible: boolean
  focused: boolean
  onFocus: () => void
}

function canMeasure(host: HTMLElement): boolean {
  return host.clientWidth >= 20 && host.clientHeight >= 10
}

export default function XtermPane({ paneId, cwd, visible, focused, onFocus }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const visibleRef = useRef(visible)
  const sizeRef = useRef({ cols: 0, rows: 0 })
  // The pane's directory at mount time; later `cd`s belong to the shell.
  const cwdRef = useRef(cwd)
  visibleRef.current = visible

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: MONO,
      fontSize: 12.5,
      lineHeight: 1.35,
      letterSpacing: 0,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    const sync = (): void => {
      // Fitting while hidden or zero-sized collapses the PTY and reprints
      // the prompt once the pane returns — that is the spam in the screenshot.
      if (!visibleRef.current || !canMeasure(host)) return
      try {
        fit.fit()
      } catch {
        /* the pane can be measured mid-layout */
      }
      const cols = term.cols
      const rows = term.rows
      if (cols < 2 || rows < 1) return
      if (sizeRef.current.cols === cols && sizeRef.current.rows === rows) return
      sizeRef.current = { cols, rows }
      void api.shell.resize(paneId, cols, rows)
    }

    // Open with a safe default size; the first visible sync corrects it.
    const openCols = canMeasure(host) ? Math.max(term.cols, 80) : 80
    const openRows = canMeasure(host) ? Math.max(term.rows, 24) : 24
    if (canMeasure(host) && visibleRef.current) {
      try {
        fit.fit()
      } catch {
        /* mid-layout */
      }
      sizeRef.current = { cols: term.cols, rows: term.rows }
      void api.shell.open(paneId, cwdRef.current, term.cols, term.rows)
    } else {
      void api.shell.open(paneId, cwdRef.current, openCols, openRows)
      sizeRef.current = { cols: openCols, rows: openRows }
    }

    const offData = api.shell.onData((e) => {
      if (e.tabId === paneId) term.write(e.chunk)
    })
    const offExit = api.shell.onExit((e) => {
      if (e.tabId === paneId) term.write('\r\n\x1b[2m[shell exited]\x1b[0m\r\n')
    })
    const keys = term.onData((data) => void api.shell.write(paneId, data))

    const ro = new ResizeObserver(sync)
    ro.observe(host)

    return () => {
      ro.disconnect()
      offData()
      offExit()
      keys.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      // PTY stays alive across tab switches; closeTab/closePane kill it.
    }
  }, [paneId])

  // After a tab or repository switch the host is on screen again — refit once
  // it has real dimensions, then redraw. Skipping zero-size fits avoids the
  // repeated-prompt corruption from collapsing the PTY.
  useEffect(() => {
    if (!visible) return
    const host = hostRef.current
    const term = termRef.current
    const fit = fitRef.current
    if (!host || !term || !fit) return

    let cancelled = false
    const run = (): void => {
      if (cancelled || !canMeasure(host)) return
      try {
        fit.fit()
      } catch {
        /* mid-layout */
      }
      const cols = term.cols
      const rows = term.rows
      if (cols < 2 || rows < 1) return
      if (sizeRef.current.cols !== cols || sizeRef.current.rows !== rows) {
        sizeRef.current = { cols, rows }
        void api.shell.resize(paneId, cols, rows)
      }
      term.refresh(0, term.rows - 1)
      if (focused) term.focus()
    }

    const id = requestAnimationFrame(() => {
      run()
      // One more frame: layout can settle after the repository slide-in.
      requestAnimationFrame(run)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(id)
    }
  }, [visible, focused, paneId])

  return (
    <div
      onMouseDown={onFocus}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        padding: '10px 12px 12px 14px',
        background: '#080D17'
      }}
    >
      <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}
