# Plan: cross-provider subagents in managed Chat

Status: proposed · Owner: TBD · Decision record to follow as an ADR once Phase 1 lands.

## Goal

An agent in managed Chat can hand a piece of work to another provider/model (Claude → Codex, Codex → Gemini via Cursor/OpenCode, …), watch it run in the same Chat, and continue with its result. Subagents work **in the same checkout** and may edit files. Tool approvals that a provider asks for are **shown to the developer** instead of being auto-approved or blocked.

## Where we are today

- `runAiOnce` (`app/electron/ai-oneshot.ts`) and `managedAiCommand` (`app/shared/ai.ts`) already spawn any provider.
- `app/electron/mcp.ts` ↔ `app/shared/bridge.ts` ↔ `handleBridge` in `app/electron/main.ts` already lets an agent ask the running app to do things (`list`, `run`, `hook`).
- Managed Claude runs with `--strict-mcp-config` (zero MCP servers) because it used to call `run_pipeline` instead of emitting `FAROL_PIPELINES`, and MCP runs (`origin: 'agent'`) never hand failures back. This also drops every user MCP server.
- Other providers still load MCP (Cursor reads `~/.cursor/mcp.json`, which Farol writes; Codex reads its own config). Only a prompt line (`agent-controller.ts:1516`) keeps them off Farol's tools.
- Every managed command auto-approves everything (`bypassPermissions`, `approval_policy=never`, `--force`, `--dangerously-skip-permissions`, `--auto-approve`) because the child's stdin is ignored and a prompt would hang.

## Principles

1. **Synchronous delegation only.** A `delegate` call blocks the caller until the subagent finishes, so exactly one agent writes to the checkout at a time. No locks or merges needed.
2. **Farol still owns validation.** Subagents never select or run pipelines; the parent selects them after the subagent returns, so the repair loop is unchanged.
3. **A subagent never exceeds its parent.** Plan parent → Plan subagent (Review gate required). Depth is 1: a subagent gets no `delegate` tool.
4. **Visible, cancellable, attributed.** Subagent activity renders nested under the parent's `delegate` card; Stop kills both; usage/spend is attributed to the subagent's provider.
5. **Approvals are surfaced where the provider allows it**, and auto-approve remains available as an explicit per-chat choice.

## Phase 1 — Managed MCP config (unblock MCP) · ~1–2 days

Replace "no MCP" with "user's MCP + a managed-only Farol server".

- **`app/shared/mcp-config.ts`**: add `managedMcpConfig(entry)` producing a one-server config under a distinct key, `farol-chat`, so it cannot collide with the project's `farol` entry.
- **Managed server env**: `FAROL_SOCKET`, `FAROL_MANAGED=1`, `FAROL_TASK_ID=<task id>`, `FAROL_DEPTH=<0|1>`.
- **`app/electron/mcp.ts`**: when `FAROL_MANAGED=1`, register only `delegate` (depth 0) and `approve`; never `run_pipeline`/`list_pipelines`. Unchanged for agents outside Farol.
- **`managedClaudeCommand`**: drop `--strict-mcp-config`; add `--mcp-config <tmp file>` and `--disallowedTools mcp__farol__run_pipeline,mcp__farol__list_pipelines` so the project `farol` entry can't reintroduce the original bug. Write the tmp file per task, delete on task dispose.
- **`managedCodexCommand`**: inject the server with `-c mcp_servers.farol-chat.command=…` / `.args` / `.env` overrides.
- **Cursor / OpenCode / OMP / Pi**: out of scope for this phase; they keep today's behavior (see Phase 4).
- **Prompt** (`agent-controller.ts:1516`): replace "Do not call the Farol MCP tools" with "Use `farol-chat` tools as described; never call `farol` pipeline tools."
- **Tests**: `ai.test.ts` for the new argv per provider; `mcp-config.test.ts` for the managed config; an `mcp.ts` test that managed mode hides pipeline tools.

Done when: a user's own MCP server is callable from managed Claude/Codex, and `FAROL_PIPELINES` still drives validation (regression test for the original reason).

## Phase 2 — Synchronous `delegate` (shared checkout, can edit) · ~1 week

**Tool contract** (`mcp.ts`, managed only):

```ts
delegate({
  provider: AiProvider,
  model?: string,
  task: string,          // what the subagent should do
  context?: string       // anything the parent wants it to know
}) → text: final answer + handoff note + `git diff --stat` of what it changed
```

**Bridge** (`app/shared/bridge.ts`): add `{ op: 'delegate'; cwd; taskId; provider; model?; task; context? }` and the matching reply `{ op: 'delegate'; text; failed }`.

**Main** (`handleBridge` in `main.ts`): route `delegate` to `AgentController.delegate(taskId, …)`; reject if the task id is unknown or not running.

**`AgentController.delegate`**:

- Guardrails: parent must be mid-turn; one subagent at a time per task (reject concurrent calls); depth 1; mode = parent's mode; Plan requires the subagent provider to have a Review gate; provider CLI must be installed (reuse `resolveBinFrom` hints).
- Spawn with `managedAiCommand(provider, prompt, model, { mode, via, … })`, reusing the existing `runAgent` spawn/parse path (refactor it to take a target sink + process slot instead of assuming `task.process`).
- Subagent prompt: the task, the parent's latest handoff note (`HANDOFF_MARKER`), the todo context, "work only in `<cwd>`", "do not emit `FAROL_PIPELINES`", "end with a `FAROL_HANDOFF` summary". No pipeline catalog. Questions (`FAROL_QUESTIONS`) are allowed and surface in Chat like the parent's.
- Track the child in `task.children`; `cancel(taskId)` kills it too.
- No fallback chain for subagents: on provider failure return `failed: true` with the reason and let the parent decide.
- Return: last assistant text, parsed handoff, `git diff --stat` since the call started.

**MCP tool timeouts** (key risk): long subagent runs exceed default MCP client timeouts. Set `MCP_TOOL_TIMEOUT` in the managed Claude env and `tool_timeout_sec` for Codex's `farol-chat` server to the delegate cap (e.g. 30 min); have `delegate` enforce the same cap itself.

**Events / UI** (`app/shared/types.ts`, `app/src`):

- Add optional `parentToolId` to `tool` / `assistant` / `output` / `question` events.
- Render subagent events nested under the parent's `delegate` tool card, labelled with provider + model (`aiSelectionLabel`).
- Busy indicator and worktree-busy flag already cover the task; verify nothing reads "idle" while a child runs.

**Usage / spend**: record the subagent's usage under its provider; the context meter stays the parent's.

**Tests**: controller tests for guardrails (concurrent, depth, plan gate, unknown task), cancel propagation, failure return, diff summary; renderer test for nested cards.

Done when: from a Claude chat, "have Codex implement X" runs Codex in the same checkout, its tool cards appear nested, Claude sees the result and diff, then Farol runs the pipelines Claude selects.

## Phase 3 — Approvals surfaced in Chat (Claude) · ~2–4 days

- **`approve` tool** (`mcp.ts`, managed only) implementing Claude's `--permission-prompt-tool` contract: input `{ tool_name, input, tool_use_id }`, output JSON `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }`.
- **Bridge** `op: 'approve'` → `AgentController.requestApproval(taskId, …)` → new event `{ kind: 'approval'; taskId; requestId; tool; detail; provider; parentToolId?; decision? }`.
- **Chat card** modelled on the question card: Allow once · Allow this tool for this chat · Deny (with optional reason). "Allow for this chat" is remembered per task in main.
- **`managedClaudeCommand`**: when approvals are on, `--permission-mode default --permission-prompt-tool mcp__farol-chat__approve` instead of `bypassPermissions`. Plan mode unchanged.
- **Setting**: per-chat "Auto-approve tools" toggle next to Plan | Build; default **on** to preserve today's behavior (see open questions).
- Approvals from a Claude subagent route to the same card, labelled with the subagent.
- Remote runs (`REMOTE_ENABLED`) keep auto-approve; no developer is attached.

Done when: in a Claude chat with auto-approve off, a Bash call shows a card, Allow runs it, Deny returns the reason to the agent, and Stop while a card is pending cancels cleanly.

## Phase 4 — Other providers (spikes, then per-provider work)

For each CLI, answer two questions — can Farol inject an MCP server per run, and is there a headless approval callback — then decide integrate vs. keep auto-approve.

| CLI | Per-run MCP | Approval callback | First guess |
|---|---|---|---|
| Claude | `--mcp-config` | `--permission-prompt-tool` | Phases 1–3 |
| Codex | `-c mcp_servers.*` | not in `exec`; `app-server` JSON-RPC has approval requests | Phase 1 now; approvals need an `app-server` migration |
| Cursor | ? (`~/.cursor/mcp.json` only?) | ? | spike |
| OpenCode | config file / server mode | `opencode serve` permission events | spike |
| OMP / Pi | ? | ? | spike |

Every "?" must be verified against the installed CLI before committing to work.

## Deferred

- **Parallel fan-out in one checkout.** Needs file claims or separate worktrees (`app/shared/worktree.ts`). Revisit after Phase 2 usage data.
- **Delegation from agents outside Farol** (the user's own terminal agent via project `.mcp.json`). Cheap once Phase 2 exists, but needs a policy for which Chat the work shows up in.

## Open questions

1. Default for "Auto-approve tools": on (today's behavior) or off (safer, more prompts)?
2. Should a subagent's edits be reviewable/revertable as a unit (snapshot before `delegate`)?
3. Do headless Claude runs load project `.mcp.json` servers that the user never approved interactively? If not, Phase 1's "user's MCP comes back" applies only to user-scope servers.
4. Delegate cap: 30 min? Configurable?
5. Which providers may be delegated to from Plan mode (all have a Review gate today — confirm per subagent spawn path)?

## Risks

- MCP tool timeouts cutting off long subagent runs (mitigated above; verify per CLI).
- The project `farol` entry still exposing pipeline tools if `--disallowedTools` naming changes upstream — keep the regression test.
- Prompt-only rules for providers without per-run MCP control (Cursor) — unchanged from today, but worth stating.
- Cost surprises from delegating to expensive models — show provider/model on the card and in spend.
