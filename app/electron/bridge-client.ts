/**
 * Client side of the bridge socket, shared by every process that asks the
 * running app to run a pipeline on its behalf (the MCP server, a Farol-managed
 * git hook). Resolves to `null` when there is no app to talk to — the app
 * being closed is an expected outcome, not an error, for either caller.
 */

import net from 'net'
import { BRIDGE_ENV, takeLines, type BridgeAsk, type BridgeReply } from '../shared/bridge'

/** How long to wait for the app to accept a connection — not for the run. */
const CONNECT_TIMEOUT_MS = 5000

export function requestBridge(req: BridgeAsk): Promise<BridgeReply | null> {
  const file = process.env[BRIDGE_ENV]
  if (!file) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    let connected = false
    let buffer = ''
    const done = (v: BridgeReply | null): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(v)
    }
    const socket = net.createConnection(file)
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      // Only the handshake is time-boxed: a pipeline legitimately takes minutes.
      if (!connected) done(null)
    })
    socket.on('connect', () => {
      connected = true
      socket.setTimeout(0)
      socket.write(JSON.stringify({ ...req, id: 1 }) + '\n')
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const { lines, rest } = takeLines(buffer)
      buffer = rest
      for (const line of lines) {
        try {
          done(JSON.parse(line) as BridgeReply)
        } catch {
          /* partial or malformed frame — keep reading */
        }
      }
    })
    socket.on('error', () => done(null))
    socket.on('close', () => done(null))
  })
}
