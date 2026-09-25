import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { BRIDGE_ENV } from '../shared/bridge'
import { requestBridge } from './bridge-client'

const originalEnv = process.env[BRIDGE_ENV]

afterEach(() => {
  if (originalEnv === undefined) delete process.env[BRIDGE_ENV]
  else process.env[BRIDGE_ENV] = originalEnv
})

describe('requestBridge', () => {
  it('resolves null without connecting when FAROL_SOCKET is unset', async () => {
    delete process.env[BRIDGE_ENV]
    await expect(requestBridge({ op: 'list', cwd: '/tmp' })).resolves.toBeNull()
  })

  it('resolves null rather than rejecting when the socket has no listener', async () => {
    process.env[BRIDGE_ENV] = path.join(os.tmpdir(), 'farol-bridge-client-test-no-listener.sock')
    await expect(requestBridge({ op: 'list', cwd: '/tmp' })).resolves.toBeNull()
  })
})
