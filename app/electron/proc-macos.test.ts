import { execFileSync, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { attribute, type ProcInfo } from '../shared/proc'
import { killSessionProcs, type KillDeps } from './proc-kill'
import { ProcSampler } from './proc-sampler'
import { ProcRegistry } from './proc-sessions'

/**
 * Runs the real helper against real processes, so it needs macOS and clang.
 * The helper is built into a temp folder, apart from the app's `build/`.
 */
const mac = process.platform === 'darwin'
const UID = process.getuid?.() ?? -1

let dir: string
let helper: string
const spawned: ChildProcess[] = []

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until<T>(read: () => Promise<T | undefined> | T | undefined, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

beforeAll(() => {
  if (!mac) return
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'farol-proc-')))
  helper = path.join(dir, 'procsnap')
  execFileSync('clang', ['-O2', path.join(__dirname, '../native/procsnap.c'), '-o', helper])
})

/** The test server leaves the agent's group on purpose, so find it by its marker and stop it. */
function killMarked(): void {
  if (!mac) return
  for (const line of execFileSync('ps', ['-axo', 'pid=,command=']).toString().split('\n')) {
    const pid = Number(line.trim().split(/\s+/)[0])
    if (line.includes('FAROL_IT_') && pid !== process.pid) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
}

afterAll(() => {
  killMarked()
  for (const child of spawned) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!mac)('agent session processes on macOS', () => {
  it('attributes a child, a grandchild and a detached server, then cleans them up', async () => {
    const worktree = path.join(dir, 'worktree')
    fs.mkdirSync(worktree)

    const server = `//FAROL_IT_SERVER\nrequire('http').createServer().listen(0)`
    const spawner = `//FAROL_IT_SPAWNER\nrequire('child_process').spawn(process.execPath,['-e',${JSON.stringify(server)}],{detached:true,stdio:'ignore'}).unref()`
    const grand = `//FAROL_IT_GRAND\nsetInterval(()=>{},1000)`
    const child = `//FAROL_IT_CHILD\nrequire('child_process').spawn(process.execPath,['-e',${JSON.stringify(grand)}],{stdio:'ignore'});setInterval(()=>{},1000)`
    const rootCode = `//FAROL_IT_ROOT\nconst cp=require('child_process');cp.spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});cp.spawn(process.execPath,['-e',${JSON.stringify(spawner)}],{stdio:'ignore'});setInterval(()=>{},1000)`

    // The agent: its own process group, working directory in the worktree.
    const root = spawn(process.execPath, ['-e', rootCode], { cwd: worktree, detached: true, stdio: 'ignore' })
    spawned.push(root)
    const registry = new ProcRegistry()
    registry.register('s1', worktree, root.pid!)
    const sampler = new ProcSampler({ registry, helperPath: helper, isVisible: () => true, onSnapshot: () => undefined, uid: UID })

    const find = (procs: { args?: string; pid: number }[], marker: string): number | undefined =>
      procs.find((p) => p.args?.includes(marker))?.pid

    const found = await until(async () => {
      const { procs } = await sampler.sample()
      const [usage] = attribute(procs, registry.list(), UID)
      // What the sampler does on each tick: remember what the agent started.
      registry.noteSeen([usage])
      const ids = ['FAROL_IT_CHILD', 'FAROL_IT_GRAND', 'FAROL_IT_SERVER'].map((m) => find(usage.procs, m))
      // The server counts once its spawner has exited and launchd has adopted it.
      const adopted = usage.procs.find((p) => p.pid === ids[2])?.via === 'cwd'
      return ids.every((id) => id !== undefined) && adopted ? { ids: ids as number[], usage } : undefined
    })
    expect(found.usage.footprint).toBeGreaterThan(0)
    expect(found.usage.cpu).toBeGreaterThanOrEqual(0)
    for (const id of found.ids) expect(found.usage.procs.find((p) => p.pid === id)!.footprint).toBeGreaterThan(0)
    // The server left the tree; only its working directory ties it to the session.
    expect(found.usage.procs.find((p) => p.pid === found.ids[2])!.via).toBe('cwd')

    // The agent ends; what it started stays.
    process.kill(root.pid!, 'SIGKILL')
    await until(() => (alive(root.pid!) ? undefined : true))
    registry.finish('s1')

    const deps: KillDeps = {
      sample: async () => (await sampler.sample()).procs,
      sessions: () => registry.list(),
      signal: (pid, signal) => {
        try {
          process.kill(pid, signal)
        } catch {
          /* gone */
        }
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      uid: UID
    }
    const stillThere = await until(async () => {
      const [usage] = attribute((await sampler.sample()).procs, registry.list(), UID)
      return found.ids.every((id) => usage.leftovers.some((p) => p.pid === id)) ? usage : undefined
    })
    expect(stillThere.leftoverFootprint).toBeGreaterThan(0)

    // Cleaning all leftovers takes what is proven the agent's; the server, found by folder, needs its own request.
    const result = await killSessionProcs('s1', undefined, deps, 500)
    expect(result.ok).toBe(true)
    if (alive(found.ids[2])) expect((await killSessionProcs('s1', found.ids[2], deps, 500)).ok).toBe(true)
    await until(() => (found.ids.some(alive) ? undefined : true), 5000)
    const [after] = attribute((await sampler.sample()).procs, registry.list(), UID)
    expect(after.procs).toEqual([])
    sampler.stop()
  }, 60_000)
})

describe.skipIf(!mac)('sampler cost', () => {
  it('costs well under 1% CPU with 10 sessions and about 300 processes', async () => {
    const TICKS = 30
    const INTERVAL_MS = 3000
    const worktree = path.join(dir, 'perf')
    fs.mkdirSync(worktree)

    // Ten sessions, each with an agent process; pad the machine up to ~300 processes.
    const registry = new ProcRegistry()
    for (let i = 0; i < 10; i++) {
      const agent = spawn('sleep', ['120'], { cwd: worktree, detached: true, stdio: 'ignore' })
      spawned.push(agent)
      registry.register(`perf-${i}`, worktree, agent.pid!)
    }
    const listed = execFileSync('ps', ['-axo', 'pid=']).toString().split('\n').filter(Boolean).length
    for (let i = listed; i < 300; i++) spawned.push(spawn('sleep', ['120'], { detached: true, stdio: 'ignore' }))
    await new Promise((resolve) => setTimeout(resolve, 500))

    const proc = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'] })
    let buffer = ''
    let wake: ((line: string) => void) | null = null
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end < 0) return
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      wake?.(line)
    })
    const tick = (): Promise<string> =>
      new Promise((resolve) => {
        wake = resolve
        proc.stdin.write('tick\n')
      })

    let jsMicros = 0
    let rows: { pid: number; cpu: number }[] = []
    let count = 0
    for (let i = 0; i < TICKS; i++) {
      const line = await tick()
      // What Farol itself spends per tick: parse the line and attribute.
      const before = process.cpuUsage()
      const parsed = (JSON.parse(line) as { p: (ProcInfo & { sec: number; usec: number; fp: number })[] }).p
      const procs = parsed.map((r) => ({ ...r, startMs: r.sec * 1000 + r.usec / 1000, footprint: r.fp, cpu: 0, name: String(r.name) }))
      attribute(procs, registry.list(), UID)
      const used = process.cpuUsage(before)
      jsMicros += used.user + used.system
      rows = parsed as unknown as { pid: number; cpu: number }[]
      count = parsed.length
    }
    // The helper lists itself, with its own CPU time in ns since it started.
    const helperNs = rows.find((r) => r.pid === proc.pid)!.cpu
    proc.kill()

    const perTickMs = helperNs / 1e6 / TICKS + jsMicros / 1000 / TICKS
    const percent = (perTickMs / INTERVAL_MS) * 100
    console.log(`sampler cost: ${perTickMs.toFixed(2)} ms per tick, ${percent.toFixed(3)}% CPU at 3 s, ${count} processes, 10 sessions`)
    expect(count).toBeGreaterThanOrEqual(250)
    expect(percent).toBeLessThan(1)
  }, 60_000)
})
