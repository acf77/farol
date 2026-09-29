import { useEffect, useMemo, useState } from 'react'
import type { View } from '../types'
import {
  closeSurface,
  defaultLayout,
  focusSurface,
  parseLayout,
  resizeSplit,
  revealSurface,
  showView,
  splitFocused,
  surfacesOf,
  viewOf,
  type Surface,
  type WorkspaceLayout
} from '../workspace-layout'

const STORAGE_KEY = 'farol.workspaceLayout'

function loadLayout(): WorkspaceLayout {
  try {
    return parseLayout(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')) ?? defaultLayout()
  } catch {
    return defaultLayout()
  }
}

/**
 * Which surfaces are on screen and how they are split. The arrangement is a
 * window preference, so it is kept across restarts and shared by every project.
 */
export function useWorkspaceLayout() {
  const [layout, setLayout] = useState(loadLayout)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
    } catch {
      // Storage unavailable: the layout just lasts for this session.
    }
  }, [layout])

  const actions = useMemo(
    () => ({
      show: (view: View) => setLayout((l) => showView(l, view)),
      reveal: (surface: Surface) => setLayout((l) => revealSurface(l, surface)),
      split: (dir: 'row' | 'col', surface: Surface) => setLayout((l) => splitFocused(l, dir, surface)),
      close: (surface: Surface) => setLayout((l) => closeSurface(l, surface)),
      focus: (surface: Surface) => setLayout((l) => focusSurface(l, surface)),
      resize: (nodeId: string, size: number) => setLayout((l) => resizeSplit(l, nodeId, size))
    }),
    []
  )

  const surfaces = useMemo(() => surfacesOf(layout.root), [layout.root])
  return { layout, view: viewOf(layout.root), surfaces, ...actions }
}
