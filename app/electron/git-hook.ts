/**
 * Runtime for a Farol-managed git hook.
 *
 * The generated `.git/hooks/<event>` shell script (see `syncManagedHooks` in
 * `git.ts`) runs this with the hook's event name and asks the open app to run
 * whatever pipelines are configured for it. No running app (socket file
 * missing, nothing listening): exit 0 so the hook never blocks a commit or
 * push just because Farol is closed. But once the app *does* answer, its
 * answer is trusted — a rejected cwd or a handler error exits non-zero
 * instead of silently passing, since that reply means something is actually
 * wrong, not that Farol is absent.
 */

import { requestBridge } from './bridge-client'
import { GIT_HOOK_EVENTS, type GitHookEvent } from '../shared/types'

async function main(): Promise<void> {
  const event = process.argv[2] as GitHookEvent
  if (!GIT_HOOK_EVENTS.includes(event)) {
    process.exit(0)
  }
  const reply = await requestBridge({ op: 'hook', cwd: process.cwd(), event })
  if (!reply) process.exit(0)
  if (!reply.ok) {
    process.stderr.write(reply.message + '\n')
    process.exit(1)
  }
  if (reply.op !== 'hook') {
    process.stderr.write('Unexpected reply from Farol\n')
    process.exit(1)
  }
  if (reply.text) process.stderr.write(reply.text + '\n')
  process.exit(reply.failed ? 1 : 0)
}

// `requestBridge` resolves rather than rejects for every "Farol isn't reachable"
// case (see bridge-client.ts), so anything that throws here is a genuine runtime
// bug, not Farol being closed — fail closed rather than silently passing the hook.
main().catch((err) => {
  process.stderr.write(`Farol git hook error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
