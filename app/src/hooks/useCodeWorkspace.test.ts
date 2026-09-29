/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const readFile = vi.fn()
const writeFile = vi.fn()
;(window as unknown as { farol: unknown }).farol = { project: { readFile, writeFile } }

const { useCodeWorkspace } = await import('./useCodeWorkspace')

function openFixture(result: { current: ReturnType<typeof useCodeWorkspace> }) {
  readFile.mockResolvedValue({
    ok: true,
    path: 'src/a.ts',
    content: 'one',
    mtimeMs: 10,
    lineEnding: 'lf'
  })
  return act(async () => {
    await result.current.openFile('src/a.ts')
  })
}

beforeEach(() => {
  readFile.mockReset()
  writeFile.mockReset()
})

describe('useCodeWorkspace', () => {
  it('opens a file into a tab and activates it', async () => {
    const { result } = renderHook(() => useCodeWorkspace('/repo'))
    await openFixture(result)
    expect(readFile).toHaveBeenCalledWith('/repo', 'src/a.ts')
    expect(result.current.tabs.map((tab) => tab.path)).toEqual(['src/a.ts'])
    expect(result.current.activePath).toBe('src/a.ts')
    expect(result.current.active?.content).toBe('one')
    expect(result.current.notice).toBeNull()
  })

  it('re-activates an already-open tab without re-reading it', async () => {
    const { result } = renderHook(() => useCodeWorkspace('/repo'))
    await openFixture(result)
    await act(async () => {
      await result.current.openFile('src/a.ts')
    })
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(result.current.tabs).toHaveLength(1)
  })

  it('surfaces a read failure as an error notice', async () => {
    readFile.mockResolvedValue({ ok: false, error: 'File not found.' })
    const { result } = renderHook(() => useCodeWorkspace('/repo'))
    await act(async () => {
      await result.current.openFile('missing.ts')
    })
    expect(result.current.tabs).toEqual([])
    expect(result.current.notice).toEqual({ kind: 'error', text: 'File not found.' })
  })

  it('blocks closing a dirty tab until the discard is confirmed', async () => {
    const { result } = renderHook(() => useCodeWorkspace('/repo'))
    await openFixture(result)
    act(() => {
      result.current.updateContent('src/a.ts', 'two')
    })
    expect(result.current.active?.content).toBe('two')
    act(() => {
      result.current.requestClose('src/a.ts')
    })
    expect(result.current.notice).toEqual({ kind: 'dirty-close', path: 'src/a.ts' })
    expect(result.current.tabs).toHaveLength(1)
    act(() => {
      result.current.confirmClose()
    })
    expect(result.current.tabs).toEqual([])
    expect(result.current.activePath).toBeNull()
  })

  it('saves dirty content with the read mtime and clears dirty state', async () => {
    writeFile.mockResolvedValue({ ok: true, mtimeMs: 20 })
    const { result } = renderHook(() => useCodeWorkspace('/repo'))
    await openFixture(result)
    act(() => {
      result.current.updateContent('src/a.ts', 'two')
    })
    await act(async () => {
      await result.current.saveActive()
    })
    expect(writeFile).toHaveBeenCalledWith('/repo', 'src/a.ts', 'two', {
      expectedMtimeMs: 10,
      overwrite: false
    })
    expect(result.current.active?.original).toBe('two')
    expect(result.current.notice).toBeNull()
  })

  it('does not write when the file is clean', async () => {
    const { result } = renderHook(() => useCodeWorkspace('/repo'))
    await openFixture(result)
    await act(async () => {
      await result.current.saveActive()
    })
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('reports an mtime conflict and overwrites only when asked', async () => {
    writeFile.mockResolvedValueOnce({ ok: false, error: 'File changed on disk.', conflict: true })
    const { result } = renderHook(() => useCodeWorkspace('/repo'))
    await openFixture(result)
    act(() => {
      result.current.updateContent('src/a.ts', 'two')
    })
    await act(async () => {
      await result.current.saveActive()
    })
    expect(result.current.notice).toEqual({ kind: 'conflict', path: 'src/a.ts' })
    expect(result.current.active?.original).toBe('one')

    writeFile.mockResolvedValueOnce({ ok: true, mtimeMs: 30 })
    await act(async () => {
      await result.current.overwriteSave()
    })
    expect(writeFile).toHaveBeenLastCalledWith('/repo', 'src/a.ts', 'two', {
      expectedMtimeMs: 10,
      overwrite: true
    })
    expect(result.current.notice).toBeNull()
    expect(result.current.active?.original).toBe('two')
  })

  it('reverts the active tab to its original content', async () => {
    const { result } = renderHook(() => useCodeWorkspace('/repo'))
    await openFixture(result)
    act(() => {
      result.current.updateContent('src/a.ts', 'two')
    })
    act(() => {
      result.current.revertActive()
    })
    expect(result.current.active?.content).toBe('one')
    expect(result.current.notice).toBeNull()
  })
})
