import { describe, expect, it } from 'vitest'
import { inTurn } from './repo-queue'

/** A promise the test opens by hand, to hold a task until the test is ready. */
function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('inTurn', () => {
  it('runs tasks with the same key one at a time, in the order they were queued', async () => {
    const log: string[] = []
    const held = gate()
    const first = inTurn('repo', async () => {
      log.push('first starts')
      await held.opened
      log.push('first ends')
    })
    const second = inTurn('repo', async () => {
      log.push('second starts')
      log.push('second ends')
    })
    await settle()
    expect(log).toEqual(['first starts'])

    held.open()
    await Promise.all([first, second])
    expect(log).toEqual(['first starts', 'first ends', 'second starts', 'second ends'])
  })

  it('does not make a task with another key wait', async () => {
    const held = gate()
    const slow = inTurn('one', () => held.opened)
    await expect(inTurn('two', async () => 'done')).resolves.toBe('done')
    held.open()
    await slow
  })

  it('gives each caller its own result, and a task that fails does not stop the ones behind it', async () => {
    const failing = inTurn('repo', async () => {
      throw new Error('boom')
    })
    const next = inTurn('repo', async () => 'still runs')
    await expect(failing).rejects.toThrow('boom')
    await expect(next).resolves.toBe('still runs')
  })

  it('starts a new queue once the old one has run dry', async () => {
    await inTurn('repo', async () => 'one')
    await settle()
    await expect(inTurn('repo', async () => 'two')).resolves.toBe('two')
  })
})
