import { useCallback, useRef, useState } from 'react'
import type { ProjectLineEnding } from '@shared/types'
import { isDirty } from '../code'

const api = window.farol

export interface CodeTab {
  path: string
  content: string
  original: string
  mtimeMs: number
  lineEnding: ProjectLineEnding
}

export type CodeNotice =
  | { kind: 'error'; text: string }
  | { kind: 'dirty-close'; path: string }
  | { kind: 'conflict'; path: string }

export function useCodeWorkspace(projectPath: string) {
  const [tabs, setTabs] = useState<CodeTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [notice, setNotice] = useState<CodeNotice | null>(null)
  const tabsRef = useRef(tabs)
  const activeRef = useRef(activePath)
  const savingRef = useRef(new Set<string>())
  tabsRef.current = tabs
  activeRef.current = activePath

  const dropTab = useCallback((path: string) => {
    const prev = tabsRef.current
    const next = prev.filter((tab) => tab.path !== path)
    const index = prev.findIndex((tab) => tab.path === path)
    setTabs(next)
    setActivePath((cur) => (cur !== path ? cur : (next[index] ?? next[index - 1])?.path ?? null))
    setNotice(null)
  }, [])

  const openFile = useCallback(
    async (relPath: string) => {
      const existing = tabsRef.current.find((tab) => tab.path === relPath)
      if (existing) {
        setActivePath(relPath)
        setNotice(null)
        return
      }
      const result = await api.project.readFile(projectPath, relPath)
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.error })
        return
      }
      setTabs((prev) => [
        ...prev,
        {
          path: result.path,
          content: result.content,
          original: result.content,
          mtimeMs: result.mtimeMs,
          lineEnding: result.lineEnding
        }
      ])
      setActivePath(result.path)
      setNotice(null)
    },
    [projectPath]
  )

  const updateContent = useCallback((path: string, content: string) => {
    setTabs((prev) => prev.map((tab) => (tab.path === path ? { ...tab, content } : tab)))
  }, [])

  const savePath = useCallback(
    async (path: string, overwrite = false) => {
      const tab = tabsRef.current.find((item) => item.path === path)
      if (!tab || !isDirty(tab.original, tab.content) || savingRef.current.has(path)) return
      savingRef.current.add(path)
      try {
        const result = await api.project.writeFile(projectPath, tab.path, tab.content, {
          expectedMtimeMs: tab.mtimeMs,
          overwrite
        })
        if (!result.ok) {
          setNotice(
            result.conflict ? { kind: 'conflict', path: tab.path } : { kind: 'error', text: result.error }
          )
          return
        }
        setTabs((prev) =>
          prev.map((item) =>
            item.path === tab.path
              ? { ...item, original: item.content, mtimeMs: result.mtimeMs }
              : item
          )
        )
        setNotice(null)
      } finally {
        savingRef.current.delete(path)
      }
    },
    [projectPath]
  )

  const saveActive = useCallback(
    (overwrite = false) => {
      const path = activeRef.current
      if (path) return savePath(path, overwrite)
    },
    [savePath]
  )

  const revertActive = useCallback(() => {
    const path = activeRef.current
    if (!path) return
    setTabs((prev) =>
      prev.map((tab) => (tab.path === path ? { ...tab, content: tab.original } : tab))
    )
    setNotice(null)
  }, [])

  const requestClose = useCallback(
    (path: string) => {
      const tab = tabsRef.current.find((item) => item.path === path)
      if (!tab) return
      if (isDirty(tab.original, tab.content)) {
        setActivePath(path)
        setNotice({ kind: 'dirty-close', path })
        return
      }
      dropTab(path)
    },
    [dropTab]
  )

  const confirmClose = useCallback(() => {
    if (notice?.kind === 'dirty-close') dropTab(notice.path)
  }, [dropTab, notice])

  const overwriteSave = useCallback(() => saveActive(true), [saveActive])

  const active = tabs.find((tab) => tab.path === activePath) ?? null

  return {
    tabs,
    activePath,
    active,
    notice,
    openFile,
    setActive: setActivePath,
    updateContent,
    saveActive,
    revertActive,
    requestClose,
    confirmClose,
    cancelNotice: () => setNotice(null),
    overwriteSave
  }
}
