/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DelegateCard } from './cards'
import type { AgentDelegateCard } from '../../types'

afterEach(cleanup)

const card: AgentDelegateCard = {
  delegateId: 't:d1',
  provider: 'codex',
  model: 'gpt-5.6',
  task: 'Write b.txt',
  state: 'done',
  diffStat: ' b.txt | 1 +\n 1 file changed, 1 insertion(+)',
  undoable: true,
  tools: [],
  said: ''
}

describe('DelegateCard undo', () => {
  it('shows what changed and undoes it', async () => {
    const onUndo = vi.fn().mockResolvedValue({ ok: true })
    render(<DelegateCard card={card} busy={false} onUndo={onUndo} />)
    expect(screen.getByText('1 file changed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(onUndo).toHaveBeenCalledWith(false))
  })

  it('is disabled while the agent works', () => {
    render(<DelegateCard card={card} busy onUndo={vi.fn()} />)
    const undo = screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement
    expect(undo.disabled).toBe(true)
    expect(undo.title).toBe('Wait for the agent to finish')
  })

  it('offers a restore naming the files when later edits overlap', async () => {
    const onUndo = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: 'overlap', restoreFiles: 3 })
      .mockResolvedValueOnce({ ok: true })
    render(<DelegateCard card={card} busy={false} onUndo={onUndo} />)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    const restore = await screen.findByRole('button', { name: 'Restore checkout (3 files)' })
    expect(screen.getByText('Overlaps later edits')).toBeTruthy()
    fireEvent.click(restore)
    await waitFor(() => expect(onUndo).toHaveBeenLastCalledWith(true))
  })

  it('shows the run as undone, with no Undo left', () => {
    render(<DelegateCard card={{ ...card, undoable: false, undone: 'undo' }} busy={false} onUndo={vi.fn()} />)
    expect(screen.getByText('Undone')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
})
