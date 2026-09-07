import { spawn } from 'child_process'
import { describe, expect, it } from 'vitest'
import { killPidTree } from './kill'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('killPidTree', () => {
  it('kills a spawned process', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore', detached: true })
    const pid = child.pid
    expect(pid).toBeGreaterThan(0)
    await new Promise<void>((resolve) => {
      if (child.pid) resolve()
      else child.once('spawn', () => resolve())
    })
    expect(alive(pid!)).toBe(true)
    killPidTree(pid!)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('process did not exit')), 3000)
      child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
    expect(alive(pid!)).toBe(false)
  })
})
