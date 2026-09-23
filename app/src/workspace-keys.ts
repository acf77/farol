import type { Dispatch, SetStateAction } from 'react'
import type { EditorState, Tab, View } from './types'
import { showsTerminal } from './types'

export interface WorkspaceKeyCtx {
  visible: boolean
  newTabOpen: boolean
  editor: EditorState | null
  paletteOpen: boolean
  settingsOpen: boolean
  gitOpen: boolean
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  activeTab: string
  active: Tab | undefined
  view: View
  termTabs: Tab[]
  tabsRef: { current: Tab[] }
  newShellTab: () => void
  splitPane: (dir: 'row' | 'col') => void
  closePane: (tabId: string, paneId: string) => void
  closeTab: (id: string) => void
  setView: Dispatch<SetStateAction<View>>
  setPaletteOpen: Dispatch<SetStateAction<boolean>>
  setActiveTab: Dispatch<SetStateAction<string>>
  saveCodeFile: () => void
  closeCodeTab: () => void
}

/** A modal dialog is open (or the workspace is hidden): shortcuts stay with it. */
function dialogOwnsKeys(ctx: WorkspaceKeyCtx): boolean {
  return !ctx.visible || ctx.newTabOpen || !!ctx.editor || ctx.paletteOpen || ctx.settingsOpen || ctx.gitOpen
}

function hasModKey(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey
}

function handleSplitShortcut(e: KeyboardEvent, ctx: WorkspaceKeyCtx): void {
  if (ctx.view === 'code') return
  e.preventDefault()
  // Pane splits when a shell is active; otherwise toggle chat/terminal split.
  const tab = ctx.tabsRef.current.find((t) => t.id === ctx.activeTab)
  if (tab?.kind === 'shell' && showsTerminal(ctx.view)) {
    ctx.splitPane(e.shiftKey ? 'col' : 'row')
  } else {
    ctx.setView((v) => (v === 'split' ? 'chat' : 'split'))
  }
}

function handleCloseShortcut(e: KeyboardEvent, ctx: WorkspaceKeyCtx): void {
  e.preventDefault()
  if (ctx.view === 'code') {
    ctx.closeCodeTab()
    return
  }
  if (e.shiftKey && ctx.active) {
    ctx.closePane(ctx.active.id, ctx.active.focus)
  } else if (ctx.activeTab) {
    ctx.closeTab(ctx.activeTab)
  }
}

function handleDigitShortcut(e: KeyboardEvent, ctx: WorkspaceKeyCtx, digit: string): void {
  const tab = ctx.termTabs[+digit - 1]
  if (!tab) return
  e.preventDefault()
  ctx.setActiveTab(tab.id)
  ctx.setView((v) => (showsTerminal(v) ? v : 'split'))
}

export function handleWorkspaceKeyDown(e: KeyboardEvent, ctx: WorkspaceKeyCtx): void {
  if (dialogOwnsKeys(ctx) || !hasModKey(e)) return
  const k = e.key.toLowerCase()
  if (k === ',') {
    e.preventDefault()
    ctx.setSettingsOpen(true)
    return
  }
  if (k === 't') {
    e.preventDefault()
    ctx.newShellTab()
    return
  }
  if (k === 's' && ctx.view === 'code') {
    e.preventDefault()
    ctx.saveCodeFile()
    return
  }
  if (k === 'd') {
    handleSplitShortcut(e, ctx)
    return
  }
  if (k === 'k') {
    e.preventDefault()
    ctx.setPaletteOpen(true)
    return
  }
  if (k === 'w') {
    handleCloseShortcut(e, ctx)
    return
  }
  if (k >= '1' && k <= '9') handleDigitShortcut(e, ctx, k)
}
