import type { AgentPane, Tab } from './types'

/** Resolve a run tab back to the shell/worktree whose branch it belongs to. */
export function chatOwnerFor(tabs: Tab[], activeId: string): Tab | undefined {
  const shells = tabs.filter((tab) => tab.kind === 'shell')
  const active = tabs.find((tab) => tab.id === activeId)
  if (active?.kind === 'shell') return active
  if (active?.kind === 'run' && active.branch) {
    return shells.find((tab) => tab.branch === active.branch) ?? shells[0]
  }
  return shells[0]
}

export function chatTabFor(tabs: Tab[], ownerTabId: string | undefined): Tab | undefined {
  if (!ownerTabId) return undefined
  return tabs.find((tab) => tab.kind === 'agent' && tab.ownerTabId === ownerTabId)
}

export function agentPaneFor(tab: Tab | undefined): AgentPane | null {
  if (!tab) return null
  const pane = tab.panes[tab.focus]
  return pane?.kind === 'agent' ? pane : null
}
