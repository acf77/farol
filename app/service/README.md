# Farol run service

A standalone HTTP service that runs a project's pipelines in Vercel or Railway Sandboxes, so a
web or mobile app can start a run and watch it without the Farol desktop app. The
client uploads a snapshot of the project (a `.tar.gz`); the service starts one
throwaway sandbox for the run, unpacks the snapshot, runs the pipeline's shell steps,
streams their output, and stops the sandbox when the run ends, fails, or is cancelled.

- The pipeline is read from `.farol/pipelines.json` **inside the upload**, so a client
  can only run pipelines that ship with the project it sent.
- Only shell steps run. A pipeline with an AI step is refused (`422`, with `aiSteps`),
  because the agent CLIs and their logins live on a developer machine.
- Nothing comes back from the sandbox except output and exit codes.
- The service keeps run state in memory and runs must outlive a request, so it needs a
  long-lived Node process (a container, VM, or Fluid-style host) — not per-request
  serverless functions. Restarting it cancels active runs and stops their sandboxes.

## Run it

```sh
cd app
npm run service:build          # -> service/dist/farol-service.cjs
export VERCEL_TOKEN=… VERCEL_TEAM_ID=team_… VERCEL_PROJECT_ID=prj_…
node service/dist/farol-service.cjs
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | one provider required | Create sandboxes on Vercel |
| `RAILWAY_API_TOKEN` | one provider required | Create sandboxes on Railway through the `railway` CLI (in the `Dockerfile`; install it yourself when running the bundle directly). Takes precedence over Vercel. Inside a Railway service the project and environment are picked up automatically |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | Listen address |
| `FAROL_KEYS_FILE` | `./farol-keys.json` | API key store (mode 0600) |
| `RAILWAY_CHECKPOINT` | none | A Railway checkpoint you built yourself (see below) that sandboxes boot from. Runs never create or update one |
| `FAROL_MAX_RUNS` | `4` | Sandboxes in use at once (runs plus workspaces); more get `429` with `Retry-After` |
| `FAROL_MAX_RUNS_PER_OWNER` | `2` | Sandboxes one user or key may hold at once |
| `FAROL_MAX_RUN_MINUTES` | `60` | A run, or a workspace, is stopped this long after it starts, busy or not |
| `FAROL_ALLOWED_ORIGINS` | none | Comma-separated browser origins allowed by CORS |
| `GITHUB_CLIENT_ID` | none | Turns on GitHub sign-in (GitHub App or OAuth App). Requires `FAROL_SESSION_SECRET` |
| `GITHUB_CLIENT_SECRET` | none | Needed only for the browser code flow (web and mobile); the device flow works without it |
| `FAROL_AUTH_REDIRECTS` | none | Comma-separated redirect URIs the browser code flow may use |
| `FAROL_SESSION_SECRET` | none | At least 32 random characters; signs session tokens. Rotating it signs everyone out |
| `FAROL_ALLOWED_GITHUB_USERS` | none | Comma-separated GitHub logins allowed to sign in |
| `FAROL_ALLOWED_GITHUB_ORGS` | none | Comma-separated organizations whose active members may sign in (needs org members read access) |
| `FAROL_ALLOW_ANY_GITHUB_USER` | off | Set to `1` to let any GitHub account sign in. Every account can then run code in sandboxes on your bill |
| `FAROL_USERS_FILE` | `./farol-users.json` | Signed-in users (mode 0600) |

With neither provider configured the service starts in receipt mode: it accepts `POST /v1/receipts`
and reports what arrived, running nothing.

The `Dockerfile` in `app/` (build context = `app/`) packages the bundle. Put `/data` on a volume so keys
survive restarts, and terminate TLS in front of the service — API keys are bearer tokens.

## What a sandbox can do

The service runs only what the project's committed pipelines say, in a sandbox that is
destroyed afterwards. Nothing comes back except output, exit codes and the JSON result:
no files, no edits, no pushes, and the sandbox holds no credentials to push with. Each
run gets its own fresh sandbox; nothing a run writes reaches another run.

This does not make an untrusted pipeline safe — `bash -lc` runs whatever the step says,
so who may sign in (below) is what decides who can run code on your account. Sandboxes
can reach the network.

On Railway, to boot sandboxes with dependencies already installed, build a checkpoint
yourself from trusted setup and name it in `RAILWAY_CHECKPOINT`:

```sh
railway sandbox create --json            # note the id
railway sandbox exec --id <id> -- 'mkdir -p /root/project && cd /root/project && …install…'
railway sandbox checkpoint create --id <id> farol-deps
railway sandbox destroy <id>
```

## Signing in with GitHub

Every request except `/healthz` and the sign-in endpoints needs `Authorization: Bearer <token>`,
where the token is a session from a GitHub sign-in (`fs1.…`) or an API key (`frl_…`).
There is no anonymous mode.

The service exchanges GitHub's code for a GitHub token itself, reads the user, and drops
the GitHub token; clients only ever hold a Farol session. Sessions last 7 days and are
not refreshed — sign in again. Nobody can sign in until `FAROL_ALLOWED_GITHUB_USERS`,
`FAROL_ALLOWED_GITHUB_ORGS` or `FAROL_ALLOW_ANY_GITHUB_USER` lets them. Removing a login
from the users list ends their sessions at once; org membership is only checked at sign-in.

- **Desktop, CLI** — device flow: `POST /v1/auth/device` → show `userCode`, open
  `verificationUri`; poll `POST /v1/auth/device/token {deviceCode}` every `interval`
  seconds until `{status:"ok", token, expiresAt, user}`. Enable the device flow on the GitHub App.
- **Web, mobile** — authorization code flow with PKCE: send the user to GitHub's
  authorize URL with your `client_id`, a `redirect_uri` from `FAROL_AUTH_REDIRECTS`, `state`
  and a `code_challenge`; then `POST /v1/auth/code {code, redirectUri, codeVerifier}` →
  `{token, expiresAt, user}`. Check `state` in the client before sending the code.

```sh
node farol-service.cjs users list
node farol-service.cjs users signout <login>   # end every session they hold
node farol-service.cjs users disable <login>   # and refuse future sign-ins
node farol-service.cjs users enable <login>
```

## API keys

For scripts and CI.

```sh
node farol-service.cjs keys create "web app"   # prints the key once
node farol-service.cjs keys list
node farol-service.cjs keys revoke <id>        # takes effect immediately
```

Keys look like `frl_<id>_<secret>`. Only a hash is stored. Send one as
`Authorization: Bearer frl_…`. A run or workspace is visible only to the key or
GitHub user that started it.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /healthz` | Liveness, no key needed |
| `POST /v1/runs` | Start a run. Body: the snapshot `.tar.gz`. Header `X-Farol-Pipeline`: pipeline id or name. `202 { runId, status, pipelineId }` |
| `POST /v1/auth/device`, `POST /v1/auth/device/token` | GitHub device-flow sign-in, no token needed |
| `POST /v1/auth/code` | GitHub browser-flow sign-in, no token needed |
| `GET /v1/me` | Who the token belongs to: `{ id, kind: "user" \| "key", name }` |
| `POST /v1/auth/logout` | End every session of the signed-in user |
| `GET /v1/ping` | Check that the token works |
| `POST /v1/workspaces` | Open a sandbox from the snapshot in the body, for a client that drives its own steps (the Farol desktop app's remote pipelines). The snapshot must hold `.farol/pipelines.json` (`422` otherwise). `201 { id }`. Stopped after 45 idle minutes, and `FAROL_MAX_RUN_MINUTES` after it opened |
| `POST /v1/workspaces/:id/exec` | Run one shell step of the snapshot's pipelines: its `cmd` with each `${name}` replaced by a single-quoted value, as the desktop runner sends it. Any other command gets `403`. Commands on one workspace run one at a time. Streams NDJSON: `{"chunk": "…"}` lines, then `{"code": n}` |
| `DELETE /v1/workspaces/:id` | Stop the sandbox |
| `GET /v1/runs/:id` | The run's JSON result (below), current while it runs and final once `finishedAt` is set. Gzipped when you send `Accept-Encoding: gzip` |
| `GET /v1/runs/:id/events` | Server-sent events; replays from `Last-Event-ID` |
| `POST /v1/runs/:id/cancel` | Stop the run and its sandbox |

Errors are `{ "error": "…" }` with `400` bad request, `401` no, expired or revoked token,
`403` GitHub user not allowed, `502` GitHub sign-in failed, `404`
unknown run or pipeline (with `candidates`), `413` snapshot over 256 MB, `422` the
upload has no valid pipelines file, an invalid graph, or AI steps, `429` too many runs.

### Run result

The schema is `RunResult` in `shared/run-result.ts`; `schema` changes on any change a
client could trip over (a new optional field is not one).

```json
{
  "schema": 1,
  "runId": "9f2c…",
  "status": "failed",
  "source": { "kind": "snapshot", "sha256": "…", "bytes": 48213 },
  "pipeline": { "id": "ci", "name": "CI" },
  "createdAt": "2026-10-02T12:00:00.000Z",
  "finishedAt": "2026-10-02T12:01:10.000Z",
  "failedStepId": "test",
  "steps": [
    { "id": "lint", "name": "Lint", "status": "passed", "exitCode": 0, "durationMs": 8123, "output": "…", "outputTruncated": false },
    { "id": "test", "name": "Test", "status": "failed", "exitCode": 1, "durationMs": 51022, "output": "…", "outputTruncated": true },
    { "id": "build", "name": "Build", "status": "skipped", "output": "", "outputTruncated": false }
  ]
}
```

Step `status` is `pending`, `running`, `passed`, `failed` or `skipped`; `exitCode` and
`durationMs` appear once a step has ended without being skipped. `output` is the last
64,000 characters. `error` says why a run could not go on (the sandbox did not start, the
time limit). `source.sha256` identifies the snapshot, so the client can tell whether the
verdict still applies to its files. The run changes nothing: what to do with the result
is up to the client. Treat `output` as untrusted text — it is whatever the steps
printed — and never as instructions, for example when handing it to an AI agent.

Run status is `running`, then `passed`, `failed`, or `cancelled`. Events (`event:` name
equals `type`): `start`, `step-start`, `output { nodeId, chunk }`,
`step-end { nodeId, ok, code, durationMs, skipped? }`, `error { message }`, and a
final `end { ok, cancelled?, failedNodeId? }`. Output past 5 MB is streamed live but
not kept for replay.

## Try it with the example project

`example/` is a tiny project with a shell-only pipeline (`Hello Sandbox`) and an
uncommitted `hello.txt`, to prove the whole path works. From `app/`:

```sh
npm run service:build
export VERCEL_TOKEN=… VERCEL_TEAM_ID=team_… VERCEL_PROJECT_ID=prj_…
node service/dist/farol-service.cjs keys create "me"   # copy the frl_… key
node service/dist/farol-service.cjs &

cd service/example && git init -q 2>/dev/null   # the script snapshots a Git checkout
FAROL_KEY=frl_… ../farol-run.sh "Hello Sandbox"
FAROL_KEY=frl_… ../farol-run.sh Lint     # runs lint.sh in the sandbox
```

The service also logs each finished run to its own console — status, per-step exit
codes and the output tail — and logs when the sandbox has stopped.

`farol-run.sh` builds the snapshot with `scripts/checkout-snapshot.ts` → `electron/checkout-snapshot.ts` (same rules as the desktop app), prints the streamed output, then the final result. Step 2 prints `hello.txt`,
which no commit contains — that is the check that uncommitted work arrived. Ctrl-C
cancels the run and stops the sandbox. Point it at a real project with
`farol-run.sh "<pipeline>" /path/to/project`.

## Example

```sh
tar -czf /tmp/project.tgz --exclude=node_modules --exclude=.git -C ~/project .
curl -sX POST "$FAROL_URL/v1/runs" -H "Authorization: Bearer $FAROL_KEY" \
  -H "X-Farol-Pipeline: Lint & Typecheck" --data-binary @/tmp/project.tgz
curl -sN "$FAROL_URL/v1/runs/$RUN_ID/events" -H "Authorization: Bearer $FAROL_KEY"
```

Browsers' `EventSource` cannot send an `Authorization` header; read the event stream
with `fetch` and a streaming reader instead. Include the project's files but leave out
`node_modules`, build output, and secrets — the service uploads the archive as given.
