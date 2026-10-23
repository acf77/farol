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
5. **Approvals are surfaced where the provider allows it.** Auto-approve stays the default, but Chat always shows when it is on.
6. **Every subagent run can be undone** as a unit from its card.
7. **No time cap.** A subagent runs until it finishes or the developer presses Stop.

## Decisions

- Auto-approve is **on by default**, and Chat shows that it is on (Phase 3).
- Each `delegate` run gets **Undo** (Phase 2).
- Subagents have **no time cap**; Stop is the only limit (Phase 2).

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

**Status: landed.** Notes from the implementation:

- Claude's `--mcp-config` takes an inline JSON string, so no temp file is written.
- `--mcp-config` and `--disallowedTools` both take several values; they sit before `--permission-mode` so they can't swallow the prompt.
- The managed server is **not started yet**: `MANAGED_MCP_TOOLS` is empty, and a server with no tools fails the client's tool listing and would show as broken. Phase 2 adds `delegate` to that list, which switches the server on for Claude and Codex.
- The managed env has no bridge socket yet. Phase 2 picks it: one app-wide socket keyed by task id is simpler than mapping a task's cwd back to its project (worktrees live outside the project directory).

## Phase 2 — Synchronous `delegate` (shared checkout, can edit, undoable) · ~1.5 weeks

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

**No time cap, but client timeouts still apply.** Farol sets no limit of its own, yet the parent CLI gives up on an MCP call after its own timeout and would orphan a running subagent. Raise those to the maximum each CLI accepts: `MCP_TOOL_TIMEOUT` in the managed Claude env, `tool_timeout_sec` on Codex's `farol-chat` server. If the parent's call is dropped anyway (parent process exits), kill the subagent and mark its card failed rather than leaving it running unseen. Verify each CLI's ceiling in the spike; if one has a hard ceiling, `delegate` needs a resume path (return "still running" with a run id the parent polls) before that CLI can delegate long tasks.

**Undo.** Each subagent run can be undone from its card, without touching changes made before it or (where possible) after it.

- *Before* the subagent starts: capture the checkout as a tree without touching the working copy or the real index — `GIT_INDEX_FILE=<tmp> git add -A && git write-tree` (tracked + untracked, `.gitignore` respected). Pin it under `refs/farol/delegate/<taskId>/<runId>/before` so `git gc` keeps it.
- *After* it returns: capture the same way as `…/after`. The card's diff and the `git diff --stat` returned to the parent both come from `before..after`, so they show only the subagent's changes.
- *Undo*: reverse-apply exactly that diff — `git diff --binary after before | git apply --3way` against the working copy. Later edits by the parent or the developer survive if they don't overlap.
- *Conflict*: if the reverse apply does not apply cleanly, change nothing and offer two choices on the card: open the conflicting files, or "Restore checkout to before this subagent", which discards everything since (confirm first, naming how many files change).
- Undo is offered while the turn is idle; during a running turn it is disabled with a tooltip.
- Undo is recorded in Chat as a user event and fed to the agent's next turn ("the developer undid the Codex subagent's changes to …").
- Refs for a chat are deleted when the chat is cleared or the worktree is removed.
- Not a git commit and not a stash: the developer's branch, index and stash list are never touched.

Code: a new `app/electron/delegate-snapshot.ts` (capture, diff, undo, cleanup) with tests against a temp repo covering untracked files, deletions, binary files, an overlapping later edit (conflict) and a non-overlapping one (clean undo).

**Events / UI** (`app/shared/types.ts`, `app/src`):

- Add optional `parentToolId` to `tool` / `assistant` / `output` / `question` events.
- Render subagent events nested under the parent's `delegate` tool card, labelled with provider + model (`aiSelectionLabel`). The card footer shows the diff stat and the **Undo** action.
- Busy indicator and worktree-busy flag already cover the task; verify nothing reads "idle" while a child runs.

**Usage / spend**: record the subagent's usage under its provider; the context meter stays the parent's.

**Tests**: controller tests for guardrails (concurrent, depth, plan gate, unknown task), cancel propagation, failure return, diff summary; renderer test for nested cards.

Done when: from a Claude chat, "have Codex implement X" runs Codex in the same checkout, its tool cards appear nested, Claude sees the result and diff, then Farol runs the pipelines Claude selects.

**Status: landed, including Undo.** Notes from the implementation:

- One app-wide managed socket (`farol-chat-<pid>.sock`) with a per-launch secret (`FAROL_CHAT_TOKEN`); requests name a task id, which the controller already maps to its checkout. Project sockets refuse `delegate`.
- If the asking agent's socket closes (its process died or was stopped), the subagent is killed and reported as stopped.
- Subagents **cannot ask the user questions**: a question would end the turn, and the calling agent is still waiting. The subagent prompt tells it to make a reasonable choice or report what it needs; question events from it are ignored.
- No handoff marker from subagents; their final reply is the summary returned to the agent.
- Subagent file writes count as the turn's writes, so mandatory pipelines still trigger.
- Client timeouts are set to a day (`MCP_TOOL_TIMEOUT`, Codex `tool_timeout_sec`); Farol itself sets no cap.
- The diff stat already comes from before/after snapshot trees (`app/electron/delegate-snapshot.ts`); Undo builds on the same snapshots.
- Undo checks the reverse patch with `git apply --check` and only then applies it to the working copy. `--3way` was ruled out: it writes the index and leaves conflict markers, and the plan promises neither.
- A failed run that still changed files can be undone too.
- The card stays one line: "N files changed · Undo". On overlap it turns into "Overlaps later edits · Restore checkout (N files) · Cancel", and the Restore button names the file count, standing in for a separate confirm dialog.
- The Undo note reaches the agent as text in front of the developer's next message, and is kept in the chat history.
- Snapshots are released when the chat is cleared. After an app restart the main process no longer knows a chat's runs, so Undo is gone and their refs are never released (clearing the chat can't find them either). Removing a worktree doesn't release them. Follow-up: release by task id from the renderer's saved chats, or sweep `refs/farol/delegate/` refs whose chat no longer exists.

## Phase 3 — Approvals surfaced in Chat (Claude) · ~3–5 days

- **`approve` tool** (`mcp.ts`, managed only) implementing Claude's `--permission-prompt-tool` contract: input `{ tool_name, input, tool_use_id }`, output JSON `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }`.
- **Bridge** `op: 'approve'` → `AgentController.requestApproval(taskId, …)` → new event `{ kind: 'approval'; taskId; requestId; tool; detail; provider; parentToolId?; decision? }`.
- **Chat card** modelled on the question card: Allow once · Allow this tool for this chat · Deny (with optional reason). "Allow for this chat" is remembered per task in main.
- **`managedClaudeCommand`**: when approvals are on, `--permission-mode default --permission-prompt-tool mcp__farol-chat__approve` instead of `bypassPermissions`. Plan mode unchanged.
- **Setting**: per-chat "Auto-approve" toggle, default **on** (today's behavior). New chats inherit the last choice made in Settings.
- **Showing it in Chat** — the developer must always be able to tell that tools run without asking:
  - A persistent **Auto-approve** chip in the composer bar beside Plan | Build, shown whenever it is on, for every provider (including those still forced to auto-approve). Clicking it turns auto-approve off for this chat; for providers without an approval callback it is disabled with a tooltip naming the provider and the reason ("Cannot ask for approval").
  - Tool cards that ran under auto-approve carry a small "auto" marker, so the transcript records it after the fact.
  - Turning it off or on mid-chat appears as one line in the transcript.
  - Takes effect from the next turn; a running turn keeps the mode it started with.
- **CONTEXT.md**: add an **Auto-approve** entry next to **Plan mode** / **Review gate**, with the chip, tooltip and mid-turn rules above.
- Approvals from a Claude subagent route to the same card, labelled with the subagent.
- Remote runs (`REMOTE_ENABLED`) keep auto-approve; no developer is attached.

Done when: in a Claude chat with auto-approve off, a Bash call shows a card, Allow runs it, Deny returns the reason to the agent, and Stop while a card is pending cancels cleanly.

**Status: landed.** Notes from the implementation:

- Verified against the real Claude CLI (2.1.x): Claude calls the prompt tool with `{ tool_name, input, tool_use_id }` (the id is also in `_meta["claudecode/toolUseId"]`); an `allow` reply runs the tool, and a `deny` message reaches the agent verbatim. An end-to-end run with Farol's exact argv, the built `mcp.js` and a stand-in bridge allowed `Write` and denied `Bash` as expected.
- `--permission-mode default` still works, although the newer CLI lists `manual` in its help; `default` keeps older CLIs working.
- `delegate` is pre-allowed (`--allowedTools mcp__farol-chat__delegate`) so handing off work never asks.
- A Claude subagent in a chat that asks first gets a managed server with only `approve`; its requests are labelled as the subagent's. Subagents that auto-approve get no server, as before.
- The chip reads "Ask first" when off rather than disappearing, so it can be turned back on. It is hidden in Plan.
- The Settings switch "Auto-approve tools in new chats" holds the default; the chip changes only that chat, which is saved with the pane.
- "auto" marks only writes and shell calls, the kinds that would have asked.
- A pending request that nobody can answer (Stop, the agent's process going away, the cycle failing) is denied and shown as "No longer waiting".

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

1. Do headless Claude runs load project `.mcp.json` servers that the user never approved interactively? If not, Phase 1's "user's MCP comes back" applies only to user-scope servers.
2. Which providers may be delegated to from Plan mode (all have a Review gate today — confirm per subagent spawn path)?
3. Should Undo also be offered for the parent agent's own turns, reusing the same snapshot code?

## Risks

- With no time cap, a CLI's own MCP timeout can still cut off a long subagent run; verify each CLI's ceiling and add the resume path where needed.
- Undo snapshots of very large untracked trees are slow; skip files above the existing snapshot size limit and say so on the card.
- The project `farol` entry still exposing pipeline tools if `--disallowedTools` naming changes upstream — keep the regression test.
- Prompt-only rules for providers without per-run MCP control (Cursor) — unchanged from today, but worth stating.
- Cost surprises from delegating to expensive models — show provider/model on the card and in spend.
