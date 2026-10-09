import { randomBytes } from 'crypto'
import type { RemoteWorkspace } from '../shared/remote'
import type { OpenWorkspace, PoolLimits } from './runs'
import { checkPool } from './runs'

/**
 * Sandboxes held open for a desktop client that drives its own steps: it
 * uploads a snapshot, runs that snapshot's pipeline steps one at a time, then
 * closes. Only commands `allows` accepts run (see `pinned.ts`). An abandoned
 * workspace is stopped once it has been idle for `idleMs`, and every workspace
 * is stopped `maxLifetimeMs` after it opened, busy or not.
 */
interface Held {
  ownerId: string
  workspace: RemoteWorkspace
  allows: (cmd: string) => boolean
  /** The command running now; the next one waits for it. */
  queue: Promise<unknown>
  idle?: NodeJS.Timeout
  expiry: NodeJS.Timeout
}

export class CommandRefused extends Error {}

export class WorkspaceRegistry {
  private held = new Map<string, Held>()
  private opening = new Map<string, number>()

  constructor(
    private open: OpenWorkspace,
    private limits: PoolLimits & { idleMs: number; maxLifetimeMs: number }
  ) {}

  /** Start a sandbox from the snapshot. Throws BusyError when the pool or the owner's share is full. */
  async create(ownerId: string, archive: Buffer, allows: (cmd: string) => boolean, signal: AbortSignal): Promise<string> {
    checkPool(this.limits, ownerId)
    this.opening.set(ownerId, (this.opening.get(ownerId) ?? 0) + 1)
    try {
      const workspace = await this.open(archive, signal)
      const id = randomBytes(8).toString('hex')
      const expiry = setTimeout(() => void this.drop(id), this.limits.maxLifetimeMs)
      expiry.unref()
      this.held.set(id, { ownerId, workspace, allows, queue: Promise.resolve(), expiry })
      this.touch(id)
      return id
    } finally {
      const left = (this.opening.get(ownerId) ?? 1) - 1
      if (left) this.opening.set(ownerId, left)
      else this.opening.delete(ownerId)
    }
  }

  /** Whether `ownerId` owns the workspace. */
  owns(id: string, ownerId: string): boolean {
    return this.held.get(id)?.ownerId === ownerId
  }

  /**
   * Run `cmd` after any command already running on this workspace. Throws CommandRefused
   * when it is not one of the snapshot's pipeline steps. The workspace cannot go idle
   * while a command runs, and its idle clock restarts after.
   */
  exec(id: string, cmd: string, onChunk: (chunk: string) => void): Promise<number> {
    const held = this.held.get(id)
    if (!held) return Promise.reject(new Error('The workspace was closed'))
    if (!held.allows(cmd)) return Promise.reject(new CommandRefused("Not a step of the pipelines in this workspace's snapshot"))
    const run = async (): Promise<number> => {
      if (!this.held.has(id)) throw new Error('The workspace was closed')
      clearTimeout(held.idle)
      try {
        return await held.workspace.exec(cmd, onChunk)
      } finally {
        this.touch(id)
      }
    }
    const result = held.queue.then(run, run)
    held.queue = result.catch(() => undefined)
    return result
  }

  async close(id: string, ownerId: string): Promise<boolean> {
    const held = this.held.get(id)
    if (held?.ownerId !== ownerId) return false
    await this.drop(id)
    return true
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.held.keys()].map((id) => this.drop(id)))
  }

  get active(): number {
    let opening = 0
    for (const count of this.opening.values()) opening += count
    return this.held.size + opening
  }

  /** Workspaces the owner has open or opening. */
  activeFor(ownerId: string): number {
    let count = this.opening.get(ownerId) ?? 0
    for (const held of this.held.values()) if (held.ownerId === ownerId) count++
    return count
  }

  private touch(id: string): void {
    const held = this.held.get(id)
    if (!held) return
    clearTimeout(held.idle)
    held.idle = setTimeout(() => void this.drop(id), this.limits.idleMs)
    held.idle.unref()
  }

  private async drop(id: string): Promise<void> {
    const held = this.held.get(id)
    if (!held) return
    this.held.delete(id)
    clearTimeout(held.idle)
    clearTimeout(held.expiry)
    await held.workspace.close()
  }
}
