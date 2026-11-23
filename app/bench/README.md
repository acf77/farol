# farol-bench

How well an agent uses Farol's tools. Can it pick the right pipelines after a code change and never run them itself? Can it ask Farol to commit, push and open a pull request in the right order, and only when asked? Can it keep the todo list right? The bench scores the **model** and the **harness** (the agent CLI that runs it, and how Farol hands it the tools), so you can compare Opus with Sonnet, and Claude Code with Codex.

```bash
cd app
bun run bench                                   # Opus 5.5 and Sonnet 5.5 in Claude Code, every case once
bun run bench -- --trials 3 --cases 'git/*'
bun run bench -- --subjects chat/claude:claude-opus-5-5@high,chat/codex:gpt-5.6,mcp/claude:claude-sonnet-5-5
bun run bench -- --reference                    # check the bench on this machine; spends no tokens
bun run bench -- --list
```

Each run writes `report.md`, `results.json` and `results.jsonl` to `bench/results/<time>/` (ignored by Git). `results.json` holds every trace, so a failure can be read in full, down to each prompt Farol sent. `--report <results.json>` rebuilds the report.

## What runs

Every case starts from a fresh copy of **tally**, a tiny text-helpers library (`fixture.ts`). Its checks run on plain Node with nothing to install. Its `CONTRIBUTING.md` states every rule its pipelines and hooks enforce. The checkout has a local `origin` to push to.

Two **surfaces**:

- **`chat`**: Farol's managed Chat, unmodified. The real `AgentController` builds the prompt and starts the CLI the way the app does. It reads the `FAROL_PIPELINES`, `FAROL_GIT` and `FAROL_TODOS` lines, runs the selected pipelines, and sends failures back for repair. Around it the bench stands in for the app (`farol.ts`):
  - Pipelines really run in the checkout and write the same failure report.
  - Commits and pushes go through the app's own `performGitAction`, with real Git hooks.
  - Only opening a pull request is faked.
- **`mcp`**: the CLI alone, as in a terminal, with Farol's real MCP server (`electron/mcp.ts`) and no Farol prompt. The bench answers the server's bridge socket the way the app does. This measures whether an agent finds `run_pipeline` and `git_*` from their descriptions alone. Claude Code only, for now.

A **subject** is `[surface/]provider[:model][@effort]`. The provider is any Farol agent CLI: `claude`, `codex`, `cursor`, `opencode`, `omp`, `antigravity`. The CLI must be installed and signed in, as it would be for Farol. Agents run with tools auto-approved, as they do in Chat with auto-approve on (Claude: `--permission-mode bypassPermissions`), inside the throwaway checkout. Your own CLI settings and `CLAUDE.md` still apply, as they do in the app.

The bench keeps Farol's saved keys out: user data goes to a temp folder. So Jev stays off (no tool focus, no pipeline auto-select), and each CLI runs on its own login. The bench measures the agent's own choices.

## Cases

| Case | What a correct agent does |
| --- | --- |
| `pipelines/bugfix` | Fixes a bug in `src/`, selects Unit tests (and Lint), not Release |
| `pipelines/question-only` | Answers, changes nothing, selects `[]` |
| `pipelines/docs-typo` | Fixes a README typo, selects Docs check |
| `pipelines/failing-tests` | Fixes failing tests **without running `node --test` itself**, lets Farol run them |
| `pipelines/feature` | Adds a helper; tests, lint and docs must pass on the final code (repairs if they fail) |
| `pipelines/release` | Runs Release through Farol when asked, edits nothing |
| `git/commit` | Asks Farol to commit the change (Chat's rule for every file change); no push |
| `git/commit-push-pr` | Commit, push, pull request against `main`, in that order |
| `git/question` | Commits nothing |
| `git/pre-commit-hook` | The changelog hook blocks the commit; adds the changelog line and asks again |
| `todos/add` | Adds a high-priority todo and keeps the rest of the list |
| `todos/finish` | Does the todo in progress and marks it completed |
| `todos/track` | Tracks a three-part request as todos and closes them all |
| `todos/cancel` | Removes or cancels one todo, leaves the others alone |
| `plan/read-only` | Plan mode: changes nothing and ends with `FAROL_PLAN: finished` |

Cases marked `chat+mcp` in `--list` also run on the MCP surface, with checks that make sense without Farol's prompt.

## Scoring

Each case lists its checks (`grade.ts`), and every case also gets:

- **outcome**: the chat finishes on its own, the files change or don't as they should, and acceptance commands pass on the final tree (the task is really done).
- **protocol** (Chat only):
  - every answer ends with one final control line;
  - Farol never has to ask again for a readable line;
  - no Farol MCP tools are called inside Chat.

A check is **critical** or **minor**. A run **passes** when every critical check passes, and is **strict** when every check passes. The report gives a pass rate per subject and a check pass rate per category: pipelines, git, todos, protocol, outcome. It also counts attempts, format retries, questions, time and cost. Claude Code's cost comes from its session transcript. Other CLIs report none yet.

Some details that matter:

- "Validated" means the pipeline ran on the agent's **final** working tree. A run before a later edit doesn't count.
- Running a catalog command yourself is matched the way Farol matches it (`shared/catalog-shell.ts`).
- When the agent asks a question, the bench answers "use your best judgment", twice at most.

## Checking the bench itself

`bun run test -- bench/` (or `npm test`) runs every case's **reference solution** through the real controller and expects 100%. It also runs scripted agents that make known mistakes, and expects exactly the right checks to fail:

- running the tests by hand;
- a malformed marker;
- a lint failure and its repair;
- a hook-blocked commit;
- committing from the shell;
- a todo line sent last;
- dropping the rest of the todo list.

It also drives Farol's MCP server with a scripted client. If Farol changes a prompt string or a control line, these tests say which check went stale.

## Adding a case

Add a `BenchCase` to `cases.ts` with:

- the user's message;
- any fixture `files` it overrides;
- its `checks`, plus `mcpChecks` to run it on the MCP surface;
- `acceptance` commands;
- a `reference` that edits the checkout and returns what a correct agent would say.

The tests then prove the reference passes.

## Adding a harness

A provider Farol's Chat already runs needs nothing: name it in `--subjects`. A new surface is a `run…(case, subject, opts) → Trace` in `harness/`. The graders only read the `Trace`.
