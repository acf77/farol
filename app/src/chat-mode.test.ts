import { createElement, type ComponentProps, type DependencyList, type EffectCallback, type ReactElement } from 'react'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, ProjectSession } from '@shared/types'
import { normalizeMode } from '@shared/ai'
import { sanitizeSession } from '@shared/session'
import { modeDefault, sanitizeSettings } from '@shared/settings'
import ChatPane, { ChatModeSwitch } from './components/ChatPane'
import type { AgentPane } from './types'

vi.mock('./components/TerminalPane', () => ({ default: () => null }))
vi.mock('./hooks/useGitPanel', () => ({
  useGitPanel: () => ({ status: null, github: null, gitAction: null, log: [], pull: vi.fn() })
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function workspaceRenderer(render: () => ReactElement) {
  const slots: unknown[] = []
  let cursor = 0
  const pending: EffectCallback[] = []
  const cleanups = new Set<() => void>()
  const slot = <T,>(create: () => T): T => {
    const index = cursor++
    if (!(index in slots)) slots[index] = create()
    return slots[index] as T
  }
  const changed = (previous: DependencyList | undefined, next: DependencyList | undefined) =>
    !previous || !next || previous.length !== next.length || next.some((value, i) => !Object.is(value, previous[i]))
  const memo = <T,>(create: () => T, deps: DependencyList | undefined): T => {
    const cell = slot(() => ({ value: create(), deps }))
    if (changed(cell.deps, deps)) {
      cell.value = create()
      cell.deps = deps
    }
    return cell.value
  }
  return {
    render() {
      cursor = 0
      const spies = [
        vi.spyOn(React, 'useState').mockImplementation(((initial: unknown) => {
          const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
          return [cell.value, (next: unknown) => {
            cell.value = typeof next === 'function' ? next(cell.value) : next
          }]
        }) as typeof React.useState),
        vi.spyOn(React, 'useRef').mockImplementation(((initial: unknown) =>
          slot(() => ({ current: initial }))) as typeof React.useRef),
        vi.spyOn(React, 'useMemo').mockImplementation(memo),
        vi.spyOn(React, 'useCallback').mockImplementation((callback, deps) => memo(() => callback, deps)),
        vi.spyOn(React, 'useEffect').mockImplementation((effect, deps) => {
          const cell = slot(() => ({ deps: undefined as DependencyList | undefined, cleanup: undefined as (() => void) | undefined }))
          if (!changed(cell.deps, deps)) return
          cell.deps = deps
          pending.push(() => {
            if (cell.cleanup) {
              cell.cleanup()
              cleanups.delete(cell.cleanup)
            }
            cell.cleanup = effect() || undefined
            if (cell.cleanup) cleanups.add(cell.cleanup)
          })
        })
      ]
      try {
        return render()
      } finally {
        spies.forEach((spy) => spy.mockRestore())
        pending.splice(0).forEach((effect) => effect())
      }
    },
    unmount() {
      cleanups.forEach((cleanup) => cleanup())
      cleanups.clear()
    }
  }
}

function chatElement(element: ReactElement): ReactElement<ComponentProps<typeof ChatPane>> | undefined {
  if (element.type === ChatPane) return element
  for (const child of React.Children.toArray(element.props.children)) {
    if (!React.isValidElement(child)) continue
    const found = chatElement(child)
    if (found) return found
  }
  return undefined
}

function renderChat(pane: AgentPane | null): string {
  const settings = sanitizeSettings({
    agent: 'claude',
    models: { claude: 'opus' },
    modeDefaults: { build: [{ agent: 'cursor', model: 'composer-2.5' }] }
  })
  const choice = modeDefault(settings, 'build')
  return renderToStaticMarkup(
    createElement(ChatPane, {
      pane,
      pipelines: [],
      view: 'chat',
      projectPath: '/repo',
      defaultProvider: choice.agent,
      defaultModel: choice.model,
      settings,
      usage: [],
      onRefreshUsage: vi.fn(),
      onMessage: vi.fn(),
      onAnswer: vi.fn(),
      onCancel: vi.fn(),
      onProviderChange: vi.fn(),
      onModeChange: vi.fn(),
      onExecutePlan: vi.fn(),
      onOpenPipeline: vi.fn(),
      onNewChat: vi.fn()
    })
  )
}

describe('restored chat model selection', () => {
  it.each([
    { provider: 'cursor' as const, model: undefined, label: 'Cursor' },
    { provider: 'codex' as const, model: undefined, label: 'Codex' },
    { provider: 'codex' as const, model: 'custom-model', label: 'Codex · custom-model' }
  ])('keeps $provider / $model instead of inheriting the settings model', ({ provider, model, label }) => {
    const pane: AgentPane = {
      id: 'agent-pane',
      kind: 'agent',
      title: 'Chat',
      cwd: '/repo',
      taskId: 'agent:sh1',
      status: 'idle',
      attempt: 0,
      provider,
      model,
      mode: 'build',
      messages: []
    }
    const session = sanitizeSession(JSON.parse(JSON.stringify({
      activeTab: 'sh1',
      tabs: [
        {
          id: 'sh1',
          title: 'zsh',
          focus: 'shell-pane',
          root: { t: 'leaf', id: 'shell-pane' },
          panes: [{ id: 'shell-pane', title: 'zsh', cwd: '/repo' }]
        },
        {
          id: 'agent:sh1',
          kind: 'agent',
          ownerTabId: 'sh1',
          title: 'Chat',
          focus: pane.id,
          root: { t: 'leaf', id: pane.id },
          panes: [pane]
        }
      ]
    })))
    const saved = session?.tabs[1].panes[0]
    expect(saved?.kind).toBe('agent')
    if (saved?.kind !== 'agent') throw new Error('Missing saved chat')
    const restored: AgentPane = {
      ...saved,
      status: 'idle',
      mode: normalizeMode(saved.mode, saved.provider)
    }
    expect(restored.model).toBe(model)
    expect(renderChat(restored)).toContain(`title="Agent: ${label}"`)
  })

  it('uses the configured Build model when no chat has been saved', () => {
    expect(renderChat(null)).toContain('title="Agent: Cursor · Composer 2.5"')
  })
})

describe('ChatModeSwitch', () => {
  it('shows Plan and Build and selects Build by default', () => {
    const html = renderToStaticMarkup(
      createElement(ChatModeSwitch, {
        mode: 'build',
        provider: 'codex',
        locked: false,
        onChange: vi.fn()
      })
    )
    expect(html).toContain('>Plan<')
    expect(html).toContain('>Build<')
    expect(html).toMatch(/aria-pressed="false"[^>]*>Plan</)
    expect(html).toMatch(/aria-pressed="true"[^>]*>Build</)
  })

  it('disables Plan with the provider-specific reason when no review gate exists', () => {
    const html = renderToStaticMarkup(
      createElement(ChatModeSwitch, {
        mode: 'build',
        provider: 'claude',
        locked: false,
        onChange: vi.fn()
      })
    )
    expect(html).toContain('title="Claude: Cannot enforce read-only"')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Plan<\/button>/)
  })

  it('locks both sides while the agent is working', () => {
    const html = renderToStaticMarkup(
      createElement(ChatModeSwitch, {
        mode: 'plan',
        provider: 'cursor',
        locked: true,
        onChange: vi.fn()
      })
    )
    expect(html.match(/disabled=""/g)).toHaveLength(2)
  })
})
