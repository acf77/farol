# Farol run service

A standalone HTTP service that runs a project's pipelines in Vercel Sandboxes, so a
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
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | required | Credentials the service creates sandboxes with |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | Listen address |
| `FAROL_KEYS_FILE` | `./farol-keys.json` | API key store (mode 0600) |
| `FAROL_MAX_RUNS` | `4` | Concurrent runs; more get `429` with `Retry-After` |
| `FAROL_ALLOWED_ORIGINS` | none | Comma-separated browser origins allowed by CORS |

A `Dockerfile` in this folder packages the bundle. Put `/data` on a volume so keys
survive restarts, and terminate TLS in front of the service — API keys are bearer tokens.

## API keys

```sh
node farol-service.cjs keys create "web app"   # prints the key once
node farol-service.cjs keys list
node farol-service.cjs keys revoke <id>        # takes effect immediately
```

Keys look like `frl_<id>_<secret>`. Only a hash is stored. Send one as
`Authorization: Bearer frl_…`. A run is visible only to the key that started it.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /healthz` | Liveness, no key needed |
| `POST /v1/runs` | Start a run. Body: the snapshot `.tar.gz`. Header `X-Farol-Pipeline`: pipeline id or name. `202 { runId, status, pipelineId }` |
| `GET /v1/runs/:id` | Status, and `result` (per-step `ok`, `code`, `skipped`, `output`) once finished |
| `GET /v1/runs/:id/events` | Server-sent events; replays from `Last-Event-ID` |
| `POST /v1/runs/:id/cancel` | Stop the run and its sandbox |

Errors are `{ "error": "…" }` with `400` bad request, `401` no or revoked key, `404`
unknown run or pipeline (with `candidates`), `413` snapshot over 256 MB, `422` the
upload has no valid pipelines file, an invalid graph, or AI steps, `429` too many runs.

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
