/**
 * Which OS processes belong to which agent session. Pure: the sampler feeds it
 * one process listing, and the UI and the kill path read the result.
 */

import { owningWorktree } from './worktree'

export interface ProcInfo {
  pid: number
  ppid: number
  pgid: number
  uid: number
  /** Start time, ms since epoch. With the pid it names one process, even after pid reuse. */
  startMs: number
  /** Bytes. `ri_phys_footprint` when the helper runs, else RSS (see `ProcSnapshot.approximate`). */
  footprint: number
  /** Percent of one core. */
  cpu: number
  name: string
  args?: string
  /** Absent when unknown (other user, or the `ps` fallback). */
  cwd?: string
}

export type SessionState = 'working' | 'done'

export interface ProcSession {
  id: string
  /** The worktree path the UI knows the session by. */
  worktree: string
  /** The same directory as the OS reports it (symlinks resolved). */
  cwdRoot: string
  /** The agent CLI. It leads its own process group. */
  rootPid: number
  /** Register time, ms. The root must have started within `ROOT_START_WINDOW_MS` of it. */
  startedAt: number
  state: SessionState
  /** `procKey`s of processes seen in the agent's tree or group, kept after they are adopted by launchd. */
  seen?: Set<string>
}

export type ProcVia = 'tree' | 'group' | 'cwd'

export interface AttributedProc extends ProcInfo {
  sessionId: string
  via: ProcVia
  isRoot: boolean
  /**
   * Proven to be the agent's: in its tree or group, or seen there before.
   * A match by working directory alone is not proof, so bulk clean-up skips it.
   */
  owned: boolean
  ports?: number[]
}

export interface SessionUsage {
  sessionId: string
  worktree: string
  state: SessionState
  procs: AttributedProc[]
  footprint: number
  cpu: number
  /** Everything but the agent itself, when the session is not working. */
  leftovers: AttributedProc[]
  leftoverFootprint: number
}

export interface WorktreeUsage {
  worktree: string
  footprint: number
  cpu: number
  leftoverCount: number
  leftoverFootprint: number
  /** e.g. "vite + 2 chromium still running (1.8 GB)"; empty without leftovers. */
  leftoverSummary: string
  sessions: SessionUsage[]
}

export interface ProcSnapshot {
  at: number
  /** True when memory is RSS from `ps`, not the physical footprint. */
  approximate: boolean
  totalFootprint: number
  worktrees: WorktreeUsage[]
  /** The color limits from settings, in GB; Farol's main process adds them before sending. */
  warnGb?: number
  alertGb?: number
}

export const ROOT_START_WINDOW_MS = 5000

/** One process, even after its pid is reused. */
export const procKey = (p: Pick<ProcInfo, 'pid' | 'startMs'>): string => `${p.pid}:${Math.floor(p.startMs / 1000)}`

/** Start times from `ps` have second resolution; the helper has microseconds. */
export function sameStart(a: number, b: number): boolean {
  return Math.abs(a - b) < 1000
}

function insideDir(path: string, dir: string): boolean {
  const base = dir.replace(/\/+$/, '')
  return path === base || path.startsWith(`${base}/`)
}

interface Claims {
  mine: ProcInfo[]
  byPid: Map<number, ProcInfo>
  children: Map<number, ProcInfo[]>
  owner: Map<number, AttributedProc>
  /** Newest session first: when two could claim a process, the later one does. */
  ordered: ProcSession[]
  /** The sessions whose agent process is still running, by session id. */
  roots: Map<string, ProcInfo>
}

function childIndex(procs: ProcInfo[]): Map<number, ProcInfo[]> {
  const children = new Map<number, ProcInfo[]>()
  for (const p of procs) {
    const list = children.get(p.ppid)
    if (list) list.push(p)
    else children.set(p.ppid, [p])
  }
  return children
}

function liveRoots(ordered: ProcSession[], byPid: Map<number, ProcInfo>): Map<string, ProcInfo> {
  const roots = new Map<string, ProcInfo>()
  for (const session of ordered) {
    const root = byPid.get(session.rootPid)
    if (root && Math.abs(root.startMs - session.startedAt) <= ROOT_START_WINDOW_MS) roots.set(session.id, root)
  }
  return roots
}

/** The first claim wins, so the tree is settled before the weaker matches. */
function claim(c: Claims, p: ProcInfo, session: ProcSession, via: ProcVia): void {
  if (c.owner.has(p.pid)) return
  const owned = via !== 'cwd' || !!session.seen?.has(procKey(p))
  c.owner.set(p.pid, { ...p, sessionId: session.id, via, isRoot: p.pid === session.rootPid, owned })
}

function claimDescendants(c: Claims, root: ProcInfo, session: ProcSession): void {
  const stack = [root.pid]
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    for (const child of c.children.get(pid) ?? []) {
      if (c.owner.has(child.pid)) continue
      claim(c, child, session, 'tree')
      stack.push(child.pid)
    }
  }
}

/** 1. The process tree under each live agent. */
function claimTrees(c: Claims): void {
  for (const session of c.ordered) {
    const root = c.roots.get(session.id)
    if (!root) continue
    claim(c, root, session, 'tree')
    claimDescendants(c, root, session)
  }
}

/**
 * 2. The agent's process group, which outlives the agent. The kernel keeps a
 * group id from being reused while the group lives, so a process that holds the
 * agent's pid but is not the agent means the id was reused: nothing in that
 * group is ours. A member must also be younger than the session.
 */
function claimGroups(c: Claims): void {
  for (const session of c.ordered) {
    if (c.byPid.has(session.rootPid) && !c.roots.has(session.id)) continue
    for (const p of c.mine) {
      if (p.pgid === session.rootPid && p.startMs >= session.startedAt - ROOT_START_WINDOW_MS) claim(c, p, session, 'group')
    }
  }
}

/**
 * The deepest worktree holding the directory, then the newest session that
 * began before the process. A process that is older than every session was not
 * started by one, so it has no owner: a directory alone is never enough.
 */
function orphanOwner(cwd: string, startMs: number, ordered: ProcSession[]): ProcSession | undefined {
  const inside = ordered.filter((s) => insideDir(cwd, s.cwdRoot) && s.startedAt <= startMs)
  const depth = Math.max(0, ...inside.map((s) => s.cwdRoot.length))
  return inside.find((s) => s.cwdRoot.length === depth)
}

/** 3. Orphans: reparented to launchd, working directory inside a worktree. */
function claimOrphans(c: Claims): void {
  for (const p of c.mine) {
    if (c.owner.has(p.pid) || p.ppid !== 1 || !p.cwd) continue
    const session = orphanOwner(p.cwd, p.startMs, c.ordered)
    if (session) claim(c, p, session, 'cwd')
  }
}

function usageOf(session: ProcSession, owned: AttributedProc[]): SessionUsage {
  const leftovers = session.state === 'done' ? owned.filter((p) => !p.isRoot) : []
  return {
    sessionId: session.id,
    worktree: session.worktree,
    state: session.state,
    procs: owned.sort((a, b) => b.footprint - a.footprint),
    footprint: owned.reduce((sum, p) => sum + p.footprint, 0),
    cpu: owned.reduce((sum, p) => sum + p.cpu, 0),
    leftovers,
    leftoverFootprint: leftovers.reduce((sum, p) => sum + p.footprint, 0)
  }
}

/**
 * Split a listing among sessions. A process has one owner; the tree and
 * process group beat a working-directory match, and `uid` limits the search
 * to the user's own processes.
 */
export function attribute(procs: ProcInfo[], sessions: ProcSession[], uid: number): SessionUsage[] {
  const mine = procs.filter((p) => p.uid === uid)
  const byPid = new Map(mine.map((p) => [p.pid, p]))
  const ordered = [...sessions].sort((a, b) => b.startedAt - a.startedAt)
  const c: Claims = { mine, byPid, children: childIndex(mine), owner: new Map(), ordered, roots: liveRoots(ordered, byPid) }
  claimTrees(c)
  claimGroups(c)
  claimOrphans(c)
  return sessions.map((session) =>
    usageOf(
      session,
      [...c.owner.values()].filter((p) => p.sessionId === session.id)
    )
  )
}

const EVAL_FLAGS = new Set(['-e', '-p', '-c', '--eval', '--print'])
const RUNTIMES = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'npm', 'npx', 'pnpm', 'yarn', 'tsx'])

/** What to call a process: `node …/.bin/vite` is `vite`. */
export function procLabel(p: Pick<ProcInfo, 'name' | 'args'>): string {
  const name = p.name.split('/').pop() || p.name
  if (!RUNTIMES.has(name) || !p.args) return name
  // `node -e <code>` has no script name to show.
  const tokens = p.args.split(/\s+/).slice(1)
  const script = tokens.find((token) => token && !token.startsWith('-'))
  if (tokens.some((token) => EVAL_FLAGS.has(token))) return name
  const base = script?.split('/').pop()?.replace(/\.(c|m)?(js|ts)x?$/, '')
  return base || name
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`
}

/** "vite + 2 chromium still running (1.8 GB)". */
export function leftoverSummary(leftovers: AttributedProc[]): string {
  if (!leftovers.length) return ''
  const counts = new Map<string, number>()
  for (const p of leftovers) counts.set(procLabel(p), (counts.get(procLabel(p)) ?? 0) + 1)
  const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => (n > 1 ? `${n} ${name}` : name))
  const shown = parts.length > 3 ? [...parts.slice(0, 3), `${parts.length - 3} more`] : parts
  const total = leftovers.reduce((sum, p) => sum + p.footprint, 0)
  return `${shown.join(' + ')} still running (${formatBytes(total)})`
}

/** Sessions of one worktree, added up; the sidebar shows one row per worktree. */
export function snapshotOf(usages: SessionUsage[], at: number, approximate: boolean): ProcSnapshot {
  const byWorktree = new Map<string, SessionUsage[]>()
  for (const u of usages) byWorktree.set(u.worktree, [...(byWorktree.get(u.worktree) ?? []), u])
  const worktrees = [...byWorktree].map(([worktree, sessions]): WorktreeUsage => {
    const leftovers = sessions.flatMap((s) => s.leftovers)
    return {
      worktree,
      footprint: sessions.reduce((sum, s) => sum + s.footprint, 0),
      cpu: sessions.reduce((sum, s) => sum + s.cpu, 0),
      leftoverCount: leftovers.length,
      leftoverFootprint: leftovers.reduce((sum, p) => sum + p.footprint, 0),
      leftoverSummary: leftoverSummary(leftovers),
      sessions
    }
  })
  return { at, approximate, totalFootprint: worktrees.reduce((sum, w) => sum + w.footprint, 0), worktrees }
}

export type MemoryLevel = 'ok' | 'warn' | 'alert'

export function memoryLevel(bytes: number, warnGb: number, alertGb: number): MemoryLevel {
  const gb = bytes / 1024 ** 3
  return gb >= alertGb ? 'alert' : gb >= warnGb ? 'warn' : 'ok'
}

/** Fold sessions into the sidebar's rows: each goes to the row whose path contains its worktree. */
export function usageByRow(snapshot: ProcSnapshot, rows: string[]): Map<string, WorktreeUsage> {
  const candidates = rows.map((path) => ({ path }))
  const sessions = snapshot.worktrees
    .flatMap((w) => w.sessions)
    .flatMap((s) => {
      const row = owningWorktree(s.worktree, candidates)
      return row ? [{ ...s, worktree: row.path }] : []
    })
  return new Map(snapshotOf(sessions, snapshot.at, snapshot.approximate).worktrees.map((w) => [w.worktree, w]))
}
