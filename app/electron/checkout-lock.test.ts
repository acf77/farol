import { describe, expect, it } from 'vitest'
import { awaitIdle, checkoutLocked, lockCheckout, trackWork, unlockCheckout } from './checkout-lock'

describe('checkout lock', () => {
  it('holds a folder for one delete and covers paths inside it', () => {
    const key = lockCheckout('/mock/repo-wt')!
    expect(lockCheckout('/mock/repo-wt')).toBeNull()
    expect(checkoutLocked('/mock/repo-wt/src/../src')).toBe(true)
    expect(checkoutLocked('/mock/other')).toBe(false)
    unlockCheckout(key)
    expect(checkoutLocked('/mock/repo-wt')).toBe(false)
  })

  it('refuses a folder that holds, or sits inside, a locked folder', () => {
    const parent = lockCheckout('/mock/repo')!
    expect(lockCheckout('/mock/repo/wt')).toBeNull()
    unlockCheckout(parent)

    const child = lockCheckout('/mock/repo/wt')!
    expect(lockCheckout('/mock/repo')).toBeNull()
    expect(lockCheckout('/mock/repo-other')).not.toBeNull()
    unlockCheckout(child)
    unlockCheckout('/mock/repo-other')
  })

  it('waits for tracked work inside the folder, and gives up after the timeout', async () => {
    let finish!: () => void
    const work = trackWork('/mock/repo-wt/sub', new Promise<void>((resolve) => (finish = resolve)))

    expect(await awaitIdle('/mock/repo-wt', 50)).toBe(false)
    expect(await awaitIdle('/mock/elsewhere', 50)).toBe(true)

    finish()
    await work
    expect(await awaitIdle('/mock/repo-wt', 50)).toBe(true)
  })
})
