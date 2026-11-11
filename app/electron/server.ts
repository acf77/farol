/**
 * `farol-server.js` — the backend running headless on a **Remote machine**.
 *
 *   farol-server.js serve    Run the backend, listening on a Unix socket next to this file.
 *   farol-server.js attach   Join this process's stdio to that socket, starting the server
 *                            first when it is not running. The desktop app runs this over SSH.
 *
 * The server outlives any one connection, so agents keep working while the
 * laptop sleeps or changes networks; the app reattaches when it is back. The
 * socket sits in a directory only this user can enter, and is only ever
 * reached through SSH, so SSH is the authentication.
 */
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { startBackend, type BackendHost } from './backend'
import type { MachineFrame } from '../shared/machine'
import { decodeFrame, encodeFrame, splitLines } from './machine-wire'
import { errorMessage } from '../shared/jev'
import { configureJevLogs } from './jev-log'
import { configureAgentFailureLogs } from './agent-failure-log'

declare const __FAROL_VERSION__: string
const VERSION = typeof __FAROL_VERSION__ === 'string' ? __FAROL_VERSION__ : 'dev'

const here = __dirname
const socketFile = path.join(here, 'farol.sock')
/** App data shared by every installed server version, like `userData` on the desktop. */
const dataDir = process.env.FAROL_SERVER_DATA || path.join(os.homedir(), '.farol-server', 'data')
const logFile = path.join(here, 'server.log')

function hasPty(): boolean {
  for (const name of ['@homebridge/node-pty-prebuilt-multiarch', 'node-pty']) {
    try {
      require.resolve(name)
      return true
    } catch {
      /* try the next */
    }
  }
  return false
}

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketFile)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

async function serve(): Promise<void> {
  // A socket file with nobody behind it is left over from a crash; another live server means we are not needed.
  if (fs.existsSync(socketFile)) {
    const existing = await connect().catch(() => null)
    if (existing) {
      existing.destroy()
      console.error('[farol-server] already running')
      return
    }
    fs.rmSync(socketFile, { force: true })
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  configureJevLogs(() => dataDir)
  configureAgentFailureLogs(() => dataDir)

  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const clients = new Set<net.Socket>()
  const write = (socket: net.Socket, frame: MachineFrame): void => {
    if (!socket.destroyed) socket.write(encodeFrame(frame) + '\n')
  }

  const host: BackendHost = {
    handle: (channel, fn) => void handlers.set(channel, fn),
    send: (channel, payload) => {
      for (const socket of clients) write(socket, { t: 'ev', ch: channel, payload })
    },
    userData: () => dataDir,
    scriptPath: (file) => path.join(here, file),
    procsnapPath: () => path.join(here, 'procsnap'),
    isVisible: () => clients.size > 0
  }
  startBackend(host)

  const onCall = async (socket: net.Socket, frame: Extract<MachineFrame, { t: 'call' }>): Promise<void> => {
    const fn = handlers.get(frame.ch)
    if (!fn) {
      write(socket, { t: 'ret', id: frame.id, ok: false, error: `The remote Farol server does not handle ${frame.ch}.` })
      return
    }
    try {
      const value = await fn(undefined, ...(Array.isArray(frame.args) ? frame.args : []))
      write(socket, { t: 'ret', id: frame.id, ok: true, value: value === undefined ? null : value })
    } catch (err) {
      write(socket, { t: 'ret', id: frame.id, ok: false, error: errorMessage(err) })
    }
  }

  const server = net.createServer((socket) => {
    clients.add(socket)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      const { lines, rest } = splitLines(buffer + chunk)
      buffer = rest
      for (const line of lines) {
        const frame = decodeFrame(line)
        if (frame?.t === 'call') void onCall(socket, frame)
      }
    })
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => socket.destroy())
    write(socket, { t: 'hello', version: VERSION, home: os.homedir(), pty: hasPty() })
  })
  const oldUmask = process.umask(0o077)
  server.listen(socketFile, () => {
    process.umask(oldUmask)
    console.error(`[farol-server] ${VERSION} listening on ${socketFile}`)
  })
  const shutdown = (): void => {
    server.close()
    fs.rmSync(socketFile, { force: true })
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

async function attach(): Promise<void> {
  let socket = await connect().catch(() => null)
  if (!socket) {
    const log = fs.openSync(logFile, 'a')
    const child = spawn(process.execPath, [__filename, 'serve'], {
      detached: true,
      stdio: ['ignore', log, log],
      cwd: os.homedir(),
      env: process.env
    })
    child.unref()
    const deadline = Date.now() + 15_000
    while (!socket && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150))
      socket = await connect().catch(() => null)
    }
    if (!socket) {
      process.stderr.write(`The Farol server did not start. See ${logFile}\n`)
      process.exit(1)
    }
  }
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
  const done = (): void => process.exit(0)
  socket.on('close', done)
  socket.on('error', done)
  process.stdin.on('end', () => socket?.end())
}

const command = process.argv[2]
if (command === 'serve') void serve()
else if (command === 'attach') void attach()
else {
  process.stderr.write('usage: farol-server.js serve | attach\n')
  process.exit(2)
}
