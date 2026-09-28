# A standalone run service starts sandbox pipelines for web and mobile clients

Remote pipelines (ADR 0004) start from the desktop app, which holds the checkout and the Vercel credentials. A web or mobile app has neither, and cannot reach a laptop reliably. We added `app/service`, a separate HTTP service that owns the Vercel credentials and creates the sandboxes directly, so a client only needs an API key and the project files.

We decided that clients upload a gzipped tar snapshot to `POST /v1/runs` and the pipeline is read from `.farol/pipelines.json` inside that upload, so the API has no pipeline-editing surface and a caller can only run pipelines that ship with what they sent. Callers authenticate with revocable API keys (`frl_<id>_<secret>`, hash stored, file re-read per request so revocation is immediate); a run is visible only to the key that started it. The API is run-and-watch: start, status, server-sent events, cancel. The sandbox mechanics are the same module the desktop uses (`electron/sandbox.ts`), and the DAG rules come from `shared/graph.ts`.

AI steps are refused, not skipped: agent CLIs and their logins live on a developer machine, and a silently skipped review would report a false pass. Run state is in memory, so the service needs a long-lived process and cancels active runs (stopping their sandboxes) on shutdown rather than resuming them.

We rejected embedding the API in the desktop app (only works while it is open and reachable), a Git-URL source (excludes uncommitted work and needs Git credentials on the service), OAuth (one owner today), a shared static secret (not revocable per client), and a queue with persisted runs (more infrastructure than the first version needs).
