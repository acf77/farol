import { describe, expect, it, vi } from 'vitest'
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
    view: 'code',
    termTabs: [],
    tabsRef: { current: [] },
    newShellTab: vi.fn(),
    splitPane: vi.fn(),
    closePane: vi.fn(),
    closeTab: vi.fn(),
    setView: vi.fn(),
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

describe('code view shortcuts', () => {
  it('saves the active file on Mod+S only in code view', () => {
    const inCode = makeCtx({ view: 'code' })
    const saveEvent = modKey('s')
    handleWorkspaceKeyDown(saveEvent, inCode)
    expect(inCode.saveCodeFile).toHaveBeenCalledTimes(1)
    expect(saveEvent.preventDefault).toHaveBeenCalled()

    const inChat = makeCtx({ view: 'chat' })
    const chatEvent = modKey('s')
    handleWorkspaceKeyDown(chatEvent, inChat)
    expect(inChat.saveCodeFile).not.toHaveBeenCalled()
    expect(chatEvent.preventDefault).not.toHaveBeenCalled()
  })

  it('closes the active code tab on Mod+W in code view', () => {
    const ctx = makeCtx({ view: 'code', activeTab: 'tab-1' })
    const event = modKey('w')
    handleWorkspaceKeyDown(event, ctx)
    expect(ctx.closeCodeTab).toHaveBeenCalledTimes(1)
    expect(ctx.closeTab).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('closes the workspace tab on Mod+W outside code view', () => {
    const ctx = makeCtx({ view: 'chat' })
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
