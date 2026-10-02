import { randomBytes } from 'crypto'
import type { RemoteWorkspace } from '../electron/sandbox'
import type { OpenWorkspace } from './runs'
import { BusyError } from './runs'

/**
 * Sandboxes held open for a desktop client that drives its own steps: it
 * uploads a snapshot, execs commands one at a time, then closes. An abandoned
 * workspace is stopped once it has been idle for `idleMs`.
 */
interface Held {
  ownerId: string
  workspace: RemoteWorkspace
  idle?: NodeJS.Timeout
}

export class WorkspaceRegistry {
  private held = new Map<string, Held>()
  private opening = 0

  constructor(
    private open: OpenWorkspace,
    private limits: { maxActive: number; idleMs: number; inUse: () => number }
  ) {}

  /** Start a sandbox from the snapshot. Throws BusyError when too many are in use. */
  async create(ownerId: string, archive: Buffer, signal: AbortSignal): Promise<string> {
    if (this.limits.inUse() >= this.limits.maxActive) throw new BusyError('Too many workspaces open')
    this.opening++
    try {
      const workspace = await this.open(archive, signal)
      const id = randomBytes(8).toString('hex')
      this.held.set(id, { ownerId, workspace })
      this.touch(id)
      return id
    } finally {
      this.opening--
    }
  }

  /** Whether `ownerId` owns the workspace. */
  owns(id: string, ownerId: string): boolean {
    return this.held.get(id)?.ownerId === ownerId
  }

  /** Run `fn` on the workspace; it cannot go idle while `fn` runs, and its idle clock restarts after. */
  async use<T>(id: string, fn: (workspace: RemoteWorkspace) => Promise<T>): Promise<T> {
    const held = this.held.get(id) as Held
    clearTimeout(held.idle)
    try {
      return await fn(held.workspace)
    } finally {
      this.touch(id)
    }
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
    return this.held.size + this.opening
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
    await held.workspace.close()
  }
}
