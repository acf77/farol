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

  it('reaches the children of a detached agent, as Stop does for chat agents', async () => {
    // A detached process leads its own group; its background child stays in that group.
    const agent = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    const childPid = await new Promise<number>((resolve) => {
      agent.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())))
    })
    expect(alive(childPid)).toBe(true)
    const exited = new Promise<void>((resolve) => agent.once('exit', () => resolve()))
    killPidTree(agent.pid!)
    await exited
    const end = Date.now() + 3000
    while (alive(childPid) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(alive(childPid)).toBe(false)
  })
})
