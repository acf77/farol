import { describe, expect, it, vi } from 'vitest'
import type { Tab } from './types'
import { handleWorkspaceKeyDown, type WorkspaceKeyCtx } from './workspace-keys'

function makeCtx(overrides: Partial<WorkspaceKeyCtx> = {}): WorkspaceKeyCtx {
  return {
    visible: true,
    newTabOpen: false,
    editor: null,
    paletteOpen: false,
    settingsOpen: false,
    gitOpen: false,
    setSettingsOpen: vi.fn(),
    activeTab: 'tab-1',
    active: undefined,
    focus: 'code',
    surfaces: ['code'],
    termTabs: [],
    tabsRef: { current: [] },
    newShellTab: vi.fn(),
    splitPane: vi.fn(),
    closePane: vi.fn(),
    closeTab: vi.fn(),
    revealSurface: vi.fn(),
    splitSurface: vi.fn(),
    setPaletteOpen: vi.fn(),
    setActiveTab: vi.fn(),
    saveCodeFile: vi.fn(),
    closeCodeTab: vi.fn(),
    ...overrides
  }
}

function modKey(key: string, opts: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...opts
  } as unknown as KeyboardEvent
}

describe('code shortcuts', () => {
  it('saves the active file on Mod+S only while Code is focused', () => {
    const inCode = makeCtx({ focus: 'code' })
    const saveEvent = modKey('s')
    handleWorkspaceKeyDown(saveEvent, inCode)
    expect(inCode.saveCodeFile).toHaveBeenCalledTimes(1)
    expect(saveEvent.preventDefault).toHaveBeenCalled()

    const inChat = makeCtx({ focus: 'chat' })
    const chatEvent = modKey('s')
    handleWorkspaceKeyDown(chatEvent, inChat)
    expect(inChat.saveCodeFile).not.toHaveBeenCalled()
    expect(chatEvent.preventDefault).not.toHaveBeenCalled()
  })

  it('closes the active code tab on Mod+W while Code is focused', () => {
    const ctx = makeCtx({ focus: 'code', activeTab: 'tab-1' })
    const event = modKey('w')
    handleWorkspaceKeyDown(event, ctx)
    expect(ctx.closeCodeTab).toHaveBeenCalledTimes(1)
    expect(ctx.closeTab).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('closes the workspace tab on Mod+W when Code is not focused', () => {
    const ctx = makeCtx({ focus: 'chat' })
    handleWorkspaceKeyDown(modKey('w'), ctx)
    expect(ctx.closeTab).toHaveBeenCalledWith('tab-1')
    expect(ctx.closeCodeTab).not.toHaveBeenCalled()
  })

  it('ignores shortcuts while a dialog owns the keyboard', () => {
    const palette = makeCtx({ paletteOpen: true })
    handleWorkspaceKeyDown(modKey('s'), palette)
    expect(palette.saveCodeFile).not.toHaveBeenCalled()

    const hidden = makeCtx({ visible: false })
    handleWorkspaceKeyDown(modKey('w'), hidden)
    expect(hidden.closeCodeTab).not.toHaveBeenCalled()
  })

  it('ignores Alt combinations and opens the palette on Mod+K', () => {
    const ctx = makeCtx()
    handleWorkspaceKeyDown(modKey('s', { altKey: true }), ctx)
    expect(ctx.saveCodeFile).not.toHaveBeenCalled()

    handleWorkspaceKeyDown(modKey('k'), ctx)
    expect(ctx.setPaletteOpen).toHaveBeenCalledWith(true)
  })
})

describe('split shortcut', () => {
  const shell = { id: 'tab-1', kind: 'shell' } as Tab

  it('splits shell panes when the terminal is focused', () => {
    const ctx = makeCtx({ focus: 'terminal', surfaces: ['terminal'], tabsRef: { current: [shell] } })
    handleWorkspaceKeyDown(modKey('d', { shiftKey: true }), ctx)
    expect(ctx.splitPane).toHaveBeenCalledWith('col')
    expect(ctx.splitSurface).not.toHaveBeenCalled()
  })

  it('splits Code or Chat beside the terminal', () => {
    const inCode = makeCtx({ focus: 'code', surfaces: ['code'] })
    handleWorkspaceKeyDown(modKey('d'), inCode)
    expect(inCode.splitSurface).toHaveBeenCalledWith('row', 'terminal')

    const inChat = makeCtx({ focus: 'chat', surfaces: ['chat'], tabsRef: { current: [shell] } })
    handleWorkspaceKeyDown(modKey('d'), inChat)
    expect(inChat.splitSurface).toHaveBeenCalledWith('row', 'terminal')
    expect(inChat.splitPane).not.toHaveBeenCalled()
  })

  it('does nothing once every surface is showing', () => {
    const ctx = makeCtx({ focus: 'chat', surfaces: ['chat', 'code', 'terminal'] })
    handleWorkspaceKeyDown(modKey('d'), ctx)
    expect(ctx.splitSurface).not.toHaveBeenCalled()
  })

  it('brings the terminal on screen for Mod+digit', () => {
    const ctx = makeCtx({ termTabs: [shell] })
    handleWorkspaceKeyDown(modKey('1'), ctx)
    expect(ctx.setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(ctx.revealSurface).toHaveBeenCalledWith('terminal')
  })
})
