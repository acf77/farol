import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { AiProvider } from '@shared/ai'
import { MONO } from '../theme'
import ScrollToLatest from './ScrollToLatest'

/**
 * A shell pane: a real terminal emulator wired straight to a PTY. xterm.js
 * owns the screen buffer, so the shell draws its own prompt and full-screen
 * programs — an interactive agent, vim, htop — work exactly as they do in the
 * user's terminal. Nothing here interprets the byte stream.
 */

const api = window.farol

/** Palette shared with the run-log renderer, so both panes look like one app. */
const THEME = {
  background: '#181817',
  foreground: '#F0F0EC',
  cursor: '#D6F23A',
  cursorAccent: '#181817',
  selectionBackground: 'rgba(214, 242, 58,0.35)',
  black: '#777772',
  red: '#FF625A',
  green: '#87C9AE',
  yellow: '#FFBE2E',
  blue: '#E3F86C',
  magenta: '#B894FF',
  cyan: '#7BBBCB',
  white: '#F0F0EC',
  brightBlack: '#A1A19A',
  brightRed: '#FF817B',
  brightGreen: '#A3DCC2',
  brightYellow: '#FFD26A',
  brightBlue: '#EDF99E',
  brightMagenta: '#CFB8FF',
  brightCyan: '#B5DCE5',
  brightWhite: '#FFFFFF'
}

interface Props {
  paneId: string
  cwd: string
  /** Dedicated AI CLI for this pane; omitted means a login shell. */
  agent?: AiProvider
  /** Tab is on screen — refit/refresh after being hidden. */
  visible: boolean
  focused: boolean
  onFocus: () => void
}

function canMeasure(host: HTMLElement): boolean {
  return host.clientWidth >= 20 && host.clientHeight >= 10
}

export default function XtermPane({ paneId, cwd, agent, visible, focused, onFocus }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const visibleRef = useRef(visible)
  const sizeRef = useRef({ cols: 0, rows: 0 })
  // The pane's directory at mount time; later `cd`s belong to the shell.
  const cwdRef = useRef(cwd)
  const [canJump, setCanJump] = useState(false)
  visibleRef.current = visible

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: MONO,
      fontSize: 12,
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
    const scroll = term.onScroll(() => setCanJump(term.buffer.active.viewportY < term.buffer.active.baseY))

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
      void api.shell.open(paneId, cwdRef.current, term.cols, term.rows, agent)
    } else {
      void api.shell.open(paneId, cwdRef.current, openCols, openRows, agent)
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
      scroll.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      // PTY stays alive across tab switches; closeTab/closePane kill it.
    }
  }, [paneId, agent])

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
        position: 'relative',
        overflow: 'hidden',
        padding: '10px 12px 12px 14px',
        background: '#181817'
      }}
    >
      <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
      <ScrollToLatest visible={canJump} onClick={() => {
        termRef.current?.scrollToBottom()
        setCanJump(false)
      }} />
    </div>
  )
}
