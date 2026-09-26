# Farol

A desktop app for running AI-assisted work in a local Git checkout, with Chat, pipelines, and Git actions on the same project.

## Language

### Source Control page

**Source Control page**:
The full-page overlay that is the only Git UI. The project-rail Git button opens it, the same way Settings opens.
_Avoid_: Git popover, second Git panel, Source Control route

**Git panel**:
The existing `useGitPanel` hook and its actions — status, draft commit, commit, push, create pull request, resolve conflicts.
_Avoid_: a second Git state machine, a parallel Git API

**Git popover**:
The old 360px anchored Git dialog. Replaced by the **Source Control page**; do not keep both.
_Avoid_: keeping a compact Git menu alongside the page

**Changes**:
The working-tree file list on the **Source Control page**: one checkbox row per **committable file**, plus kind letter and Stage all. Conflict paths and secret-looking paths do not get a row. Line-diff stats are intentionally omitted so the status poll does not add a numstat query.
_Avoid_: Working changes, split Staged / Not staged / New / Conflicts lists as the page layout, conflict checkboxes, secret rows

**Committable file**:
A unique path from staged, unstaged, or untracked that is not a secret-looking path. Conflict paths are not committable.
_Avoid_: every dirty path, conflict files, secret-looking files

**Commit selection**:
Which committable files the next commit includes, chosen with **Changes** checkboxes. First load is the first status for this project this session: every committable file is selected. Later status reloads, and closing then reopening the **Source Control page**, keep each still-committable path as the user left it, select newly appeared committable files, and drop paths that are gone. The selection lives on the **Git panel** for the session: it resets when the project switches and is not saved to disk. Stage all selects every committable file. An empty selection cannot commit, even if the tree is still dirty. Commit makes the git index match this selection — selected files in, other committable files out — then commits with no pathspec, so an already-staged unchecked file cannot sneak in. If that commit then fails, unchecked files that were staged before the attempt go back to staged with a whole-file `git add` of each restored path. Newly staged selected files are still taken back out of the index, as today. The index is not a user-facing **Changes** action.
_Avoid_: Stage, unstage, `git add` as a Source Control action, committing with a pathspec while leaving leftover staged files in the index, starting with a mixed or empty selection, resetting every poll or reopen to all-on, empty commits from an unchecked list, persisting checks to disk, leaving previously staged unchecked files unstaged after a failed commit, restoring with an index snapshot or hunk replay

**Commit message**:
The always-visible commit box on the **Source Control page**. The user can type it; **Generate with AI** is optional. Commit uses this text and the current **Commit selection**. An empty or whitespace-only message still cannot commit. There is no Cancel — the box stays; the user edits or clears the text; **Generate with AI** replaces it. It lives on the **Git panel** like today's draft: it survives closing the **Source Control page**, resets when the project switches, is cleared after a successful commit, and is not saved to disk.
_Avoid_: Draft-first popover footer, hiding the box until a message is generated, requiring Generate before Commit, a Cancel that hides the box or drops the text, empty commits, persisting the text to disk, a different lifetime than today's draft

**Generate with AI**:
An optional **Commit message** draft built from the **Commit selection** at generate time only. It does not lock that file list; Commit still uses the current selection.
_Avoid_: drafting from every committable file, making Generate a required step before Commit, treating the generated file list as a later mismatch check

**Latest commits**:
The always-visible recent-commit list on the **Source Control page**.
_Avoid_: collapsed Recent commits details

**Pull request**:
The Compare, Base, **Merge status**, **Check conflicts**, title, description, **Generate with AI**, Create pull request, GitHub Actions checks, merge-strategy, and Merge block on the **Source Control page**. Compare is the current branch. Base is a selector over the known merge/PR base, local branches, and remote-tracking branches, minus the current branch; it defaults to the known base, else a conventional base (`staging`, `main`, `master`, `develop`), else the repository default. Title and description are optional inputs kept on the **Git panel** for the project session (they survive closing the page, reset on project switch, and are not saved to disk). **Generate with AI** replaces both from the commits and diff against the chosen base. Create pull request stays hold-to-confirm and runs `gh pr create --fill`, adding `--base`, `--title`, and `--body` when those fields are non-empty. When a PR is already open, the block shows Actions summary and check rows, a merge-strategy selector that must be chosen each time, and a hold-to-confirm Merge that stays disabled while the PR is draft, conflicting, or waiting on required checks. Working-tree conflict paths and predicted GitHub conflict paths stay as lists on this block; **Merge status** text stays.
_Avoid_: Compare as a checkout picker, defaulting Base to the current or most recent feature branch, offering the current branch as its own base, hiding remote-only bases, Base as a fixed read-only field, dropping the title or description inputs, moving conflict paths off this block, hiding those paths, merging without an explicit strategy, merging while required checks are pending or failing, merging drafts or conflicting PRs

**Check conflicts**:
The always-visible **Pull request** action that is today's Resolve with AI: two-click confirm, same block reasons, then merge the PR or base and send files to Chat.
_Avoid_: hiding the button until a conflict signal, one-click resolve, a new merge or conflict path

**Merge status**:
The **Pull request** line that reports GitHub or base-merge conflict state. Until that has loaded, it reads Merge status unknown.
_Avoid_: hiding merge status when the tree is clean, a second status source

**Git log**:
The activity transcript on the **Source Control page**. Each line is a timed outcome of commit, push, create pull request, merge pull request, **Check conflicts**, a **Generate with AI** failure (commit or pull request), or a status refresh failure. It replaces the single success and error banners. A successful generate is not a line — the **Commit message** or **Pull request** draft fields are the success. Refresh failures use one line per streak: append when a refresh fails after a success or on the first fail; stay quiet while it keeps failing; do not log successful polls. It lives on the **Git panel** for the session: it survives closing the **Source Control page**, resets when the project switches, and is not saved to disk. It is not a fetch log and does not add a fetch action.
_Avoid_: a single success/error banner as the only history, fetch lines, treating this as **Latest commits**, persisting the transcript to disk, keeping lastMessage/error as a second history, a line for every failed poll, logging successful refreshes, logging a successful generate, a silent generate failure

**Source Control refresh**:
The always-visible header control that reloads git status, recent commits, and GitHub PR/check state. It uses the existing refresh icon, stays disabled while an update is active, and surfaces the latest refresh error in its tooltip (and still in **Git log**). It replaces the error-only Retry control.
_Avoid_: showing Retry only after failure, a second refresh path, hiding refresh while clean

### Plan mode

**Plan mode**:
A Chat mode in which the agent may inspect the project, ask clarifying questions, and propose a plan without changing project files or performing actions that modify the project or external systems.

**Build mode**:
A Chat mode in which the agent may change project files and perform actions that modify the project or external systems.
_Avoid_: Agent (as a mode name), Implement

**Execute plan**:
An explicit developer action that switches the Chat from Plan mode to Build mode and asks the agent to implement the proposed plan.

**Execute message**:
A user Chat message with the fixed text “Execute the plan”, created by selecting **Execute plan**.
_Avoid_: implementation prompt, run prompt

**Finished plan**:
A proposed implementation plan that the agent explicitly marks as complete and ready for the developer to execute.

**Review gate**:
The existing read-only enforcement a provider already uses for pipeline reviews. Prompt-only instructions are not a **Review gate**.
_Avoid_: sandbox (as the product name for this rule), ask mode (except as Cursor’s review mechanism)

### Agent Git actions

**Git action**:
A version-control operation Farol performs for an agent the way it runs a pipeline for it: status, commit, push, or create pull request.
_Avoid_: Git command, agent-run git, a second version-control path

**FAROL_GIT control line**:
The hidden line a managed Chat agent emits to ask Farol for a **Git action**, because that Chat cannot call the Farol MCP tools. It is `FAROL_GIT:` followed by one JSON object on one line — for example `{ "action": "commit", "message": "…" }` — and is stripped from the visible message like the other control lines.
_Avoid_: a Farol MCP call inside managed Chat, prose that describes a commit, the agent running git itself

**Git tool**:
A Farol MCP tool that carries a **Git action** over the bridge to the running app: `git_status`, `git_commit`, `git_push`, `git_create_pr`. Terminal-pane and other MCP clients use these; managed Chat uses the **FAROL_GIT control line** instead.
_Avoid_: git run inside the MCP server's own process, a path that bypasses the app

**Agent commit**:
The commit a **Git action** creates, including exactly the files the current agent turn changed — never the user's **Commit selection**.
_Avoid_: committing the **Commit selection**, committing the whole working tree, `git add -A`

**Git hook pipeline**:
A pipeline bound to a **Git action** in `.farol` that runs as a gate: when it passes, Farol performs the action; when it fails, Farol does not, and the failure goes back to the agent.
_Avoid_: a script in `.git/hooks` (Farol still performs the action itself), a check after the action, a pipeline the agent picks with `FAROL_PIPELINES`

**Git actions toggle**:
The master, machine-scoped switch in Settings that decides whether Farol performs agent **Git actions**. On by default, with no per-project override.
_Avoid_: per-project or per-action switches, off by default

**Managed-chat contract**:
The standing rules Farol gives a managed Chat agent — work only in the project, never run the catalog's commands, explain a proposed or completed change with a **Chat diagram**, end each Build turn with `FAROL_QUESTIONS` or `FAROL_PIPELINES`, and, when the turn changed files, commit them through `FAROL_GIT`.
_Avoid_: relying on the agent to remember to commit, a per-turn reminder to commit

**Chat diagram**:
A Mermaid flowchart or sequence diagram the agent puts in a ` ```mermaid ` fenced block. Chat renders it as SVG in the message. A finished plan includes one for the intended approach; a Build turn that changed files includes one for what changed and why. Four to twelve well-labeled steps, detailed but not crowded.
_Avoid_: a new control line, a remote image URL, a 20-node map, a diagram on a questions-only or status-only reply

**CLI session**:
The conversation a coding CLI saves for a managed Chat, by id. The next turn resumes it when it runs on the same CLI in the same directory, and then sends only the new request. A session the CLI refuses, or one that ran out of context, is dropped once per turn and the turn runs again with the **Rebuilt history**.
_Avoid_: resuming across providers or directories, spending a same-model retry on a refused resume

**Rebuilt history**:
What a turn that cannot resume a **CLI session** gets instead: the task, the newest follow-ups that fit a 100k-character budget, and the **Handoff note**. Trimming drops the oldest follow-ups and says so; the task always stays.
_Avoid_: cutting from the front (losing the task), a Farol summarizer call, resending it to a resumed session

**Handoff note**:
The agent's own summary for whichever agent takes the next turn — what is done, decisions, dead ends, next step — sent on a hidden `FAROL_HANDOFF:` line when the work's state changed. A new line replaces the note. The chat pane saves it with the **CLI session** reference so the chat continues after a restart.
_Avoid_: a note on every turn, sharing notes across chats or checkouts, saving the full history to disk
### Todo list

**Todo list**:
The task list a managed agent maintains with a hidden `FAROL_TODOS:` control line — Farol's stand-in for OpenCode's `todowrite`, because managed Chat runs every CLI with project MCP disabled. One line carries the whole list as JSON; a valid line replaces it and `FAROL_TODOS: []` clears it. It belongs to a checkout, so every chat in that checkout reads and writes the same list.
_Avoid_: per-chat todos, per-repo or per-worktree-group todos, a Farol MCP todo tool, partial updates or per-item edits, storing the list in `.farol` or committing it

## Relationships

### Source Control page

- A project checkout has at most one **Source Control page** open
- The **Source Control page** is driven by the same **Git panel** as the old **Git popover**
- The **Source Control page** shows **Changes**, **Commit message**, **Latest commits**, **Pull request**, and **Git log** — and nothing else
- **Commit selection** decides which files the next commit includes; unselected files stay in the working tree
- A **Changes** row is one **committable file**; secrets and conflict paths do not get a row
- **Changes** first load selects every committable file
- After that first load, status reloads and reopen keep the user's **Commit selection** for still-committable paths, select newly appeared committable files, and drop gone paths
- **Commit selection** lives on the **Git panel** for the session: it survives close, resets on project switch, and is not saved to disk
- **Generate with AI** reads only the files in **Commit selection** at generate time
- Commit does not require **Generate with AI**; a typed **Commit message** is enough
- There is no Cancel on the **Commit message** box; it stays visible and the text stays until the user edits it, Generate replaces it, a successful commit clears it, or the project switches
- Commit is never blocked because a generated file list does not match the live committable set or the current **Commit selection**; it uses the current **Commit message** and the current **Commit selection**
- Commit is disabled when **Commit selection** is empty, even if the working tree is still dirty; it does not create an empty commit
- Commit applies **Commit selection** by making the index match it, then committing; it does not commit every already-staged committable file
- If that commit fails, unchecked files that were staged before the attempt are restored to staged with a whole-file `git add`; files this attempt newly staged are still unstaged
- An empty or whitespace-only **Commit message** still cannot commit
- The **Commit message** lives on the **Git panel** like today's draft: it survives close, resets on project switch, clears after a successful commit, and is not saved to disk
- **Pull request** Compare is the current branch; Base, title, and description are real create inputs: Base picks the `--base` target and title/body pass `--title`/`--body` when non-empty to `--fill`; create still does not check out a branch
- **Pull request** title and description live on the **Git panel** for the session: they survive close, reset on project switch, and are not saved to disk
- **Generate with AI** on **Pull request** replaces both title and description from the chosen base's commit log and diff, omitting secret-looking paths
- An open **Pull request** shows GitHub Actions summary and per-check rows; Merge requires an explicit strategy each time and stays blocked while draft, conflicting, or waiting on required checks
- **Check conflicts** is always on the **Pull request** block and is the same **Git panel** resolve action
- **Merge status** is Merge status unknown until GitHub or base-merge status has loaded
- Working-tree and predicted conflict paths stay listed on the **Pull request** block; they are not **Changes** rows
- **Source Control refresh** is always in the header; it replaces the error-only Retry control and keeps refresh errors in the tooltip and **Git log**
- **Git log** appends timed outcomes for commit, push, create pull request, merge pull request, **Check conflicts**, **Generate with AI** failures, and refresh failures; it does not add fetch
- A successful **Generate with AI** is not a **Git log** line; the **Commit message** or **Pull request** draft fields are the success
- A refresh-failure **Git log** line is one per streak: append on the first fail or after a success, stay quiet while failures continue, and do not log successful polls
- **Git log** lives on the **Git panel** for the session: it survives close, resets on project switch, and is not saved to disk

### Plan mode

- The Chat input selects either **Plan mode** or **Build mode** with a **Plan | Build** switch inside the input, on the bottom left — two labeled sides, not a single toggle, menu, or icon-only control. That switch replaces the Clear chat control that previously occupied the same slot. After that replacement, Clear chat stays on existing surfaces only: the last assistant footer and the project rail. It is not added to the Chat header, the command palette, or another slot in the Chat input.
- A new Chat starts in **Build mode**, including after the developer clears the conversation.
- Selecting **Plan mode** permits reading and planning; it does not authorize implementation.
- Selecting **Build mode** authorizes implementation.
- **Plan mode** is available only for providers that have a **Review gate**. Today that is every provider — Codex, Cursor, OMP, Claude, OpenCode, and OpenRouter, which rides OpenCode's CLI and so inherits its **Review gate**. Instructions to avoid changes alone are not a **Review gate**.
- When the current provider has no **Review gate**, the **Plan | Build** switch stays visible with both labels. The Plan side is disabled and cannot be selected; the Build side stays selected. Farol does not hide the switch, remove the Plan label, or leave Plan clickable.
- That unavailable Plan side carries a tooltip that names the current provider and uses the exact reason “Cannot enforce read-only”. Farol does not use a generic phrase that omits the provider, a mention of **Review gate**, or a longer explanation, and it does not add a banner, toast, status line, or other Chat copy for that explanation.
- Farol Plan uses that same **Review gate**, enforced with each provider's own read-only mode: Codex's `--sandbox read-only`, Cursor's `--mode=plan`, OMP's read-only tool allowlist, Claude's `--permission-mode plan`, and OpenCode's `--agent plan`. OpenRouter runs through the OpenCode CLI, so it uses that same `--agent plan`.
- Selecting a provider that has no **Review gate** while **Plan mode** is selected switches the Chat to **Build mode**; **Plan mode** cannot remain selected for that provider. This does not consume **Execute plan**.
- That forced switch still happens if the agent is working. Locking the mode selector stops the developer from picking a mode, not Farol from leaving **Plan mode** when the new provider has no **Review gate**.
- After Farol switches the Chat to **Build mode** because the provider has no **Review gate**, later selecting a provider that has one leaves the Chat in **Build mode**; **Plan mode** is not restored automatically.
- **Plan mode** stays selected for subsequent messages in the same Chat until the developer selects **Build mode** manually, Farol switches to **Build mode** because the provider cannot enforce read-only access, or the developer selects **Execute plan**.
- The selected mode is remembered per Chat when reopening that Chat or restarting Farol.
- The Chat mode selector is locked while the agent is working and becomes available again when the response finishes or is stopped.
- Finishing a plan does not start implementation; an Execute button on that **Finished plan** message provides the **Execute plan** action. The button sits below the plan content on that message. It is not placed in the Chat input, the Chat header, a separate banner, or beside the plan.
- A Plan-mode response is a **Finished plan** only when the agent emits the hidden control line `FAROL_PLAN: finished` as the last line of the reply. Farol does not infer a **Finished plan** from headings, wording, structure, an earlier line, or any other `FAROL_PLAN:` value. Questions, partial drafts, and ordinary replies omit that line and are not eligible for Execute. The line is stripped from the visible message, the same way other Chat control lines are.
- In Plan mode, that last line replaces the usual Chat endings: a **Finished plan** ends with `FAROL_PLAN: finished` instead of `FAROL_QUESTIONS` or `FAROL_PIPELINES`. Those two endings are not also required on a Finished plan.
- In Plan mode, a reply that needs a decision still ends with `FAROL_QUESTIONS`, the same way as in **Build mode**. Farol shows the questions and sends the answers back. That reply is not a **Finished plan**, so it has no Execute button.
- In Plan mode, a reply that is neither a decision nor a **Finished plan** — for example it only reports what was found — ends with `FAROL_PIPELINES: []`. That empty list is the last line; it is not a **Finished plan** and does not start validation by itself.
- In Plan mode, Farol never runs pipelines selected via `FAROL_PIPELINES`, even if the reply lists real pipeline IDs instead of `[]`. Those IDs do not start validation. Farol still accepts the reply as ordinary Chat text: it does not reject the turn, hide it, or ask the agent to retry.
- **Execute plan** both switches the Chat to **Build mode** and starts implementation. Farol adds an **Execute message** — a user message whose text is always “Execute the plan” — rather than asking the developer to compose an implementation prompt.
- Typing “Execute the plan” in the composer and sending it is not **Execute plan**. It is an ordinary follow-up: it does not start implementation, and it immediately removes the earlier plan’s Execute button. Only the Execute button is **Execute plan**.
- Only the latest proposed plan in a Chat is eligible for **Execute plan**; earlier plans remain in the conversation without an active Execute button.
- Sending any follow-up message immediately removes the earlier plan's Execute button, including clarification questions and revision requests, even if the follow-up later fails or is canceled; only a new **Finished plan** can become eligible for execution.
- Reopening a Chat or restarting Farol restores the Execute button for its latest unexecuted **Finished plan**, provided no follow-up message has invalidated it.
- Selecting **Execute plan** consumes that plan's Execute button permanently, even if implementation fails or is canceled; the Chat stays in **Build mode** until the developer selects **Plan mode** again.
- Selecting **Build mode** manually does not consume the latest **Finished plan**'s Execute button; **Execute plan** remains available until a follow-up is sent or **Execute plan** is selected, and it starts implementation even if the Chat is already in **Build mode**.

### Agent Git actions

- Farol offers **Git actions** — status, commit, push, create pull request — to agents the way it offers pipelines.
- A **Git action** runs inside Farol; the agent process does not run git for it.
- Managed Chat requests a **Git action** with the **FAROL_GIT control line**; an agent outside managed Chat uses the matching **Git tool**.
- The **Managed-chat contract** compels the agent to commit its own work: a turn that changed files generates a commit message and requests a commit, and it may then request a push.
- An **Agent commit** contains the files that turn changed, not the user's **Commit selection**.
- A **Git hook pipeline** is chosen per action in `.farol`; the same action on another project may use a different pipeline, or none.
- A failing **Git hook pipeline** blocks only that action, and the failure reaches the agent like a validation failure so it can repair.
- The **Git actions toggle** gates every **Git action**: when it is off, Farol refuses even a bound hook and a valid request, and says so.
- A failed or refused **Git action** does not replace the turn's own `FAROL_PIPELINES` validation; the hook pipeline is separate from that selection.
- A **Git action** outcome appears on the existing **Git panel**: the **Git log** records it and the panel refreshes.
- Status is read-only; commit, push, and create pull request change the checkout or the remote.
- **Plan mode** never performs a **Git action**; a `FAROL_GIT` line in Plan mode is ignored the way a non-empty `FAROL_PIPELINES` list is, and the reply is still accepted.
- The **Git actions toggle** is machine-scoped and is not saved per project.

### Chat diagram

- A **Chat diagram** is a ` ```mermaid ` fenced block in an assistant message; Chat renders it as SVG in `MarkdownBody`.
- The **Managed-chat contract** asks for one when the agent proposes a plan and again after a Build turn that changed files.
- Plan mode diagrams the intended approach; a post-change Build diagram shows what changed and why.
- Questions-only and status-only replies skip a **Chat diagram**.
- There is no `FAROL_DIAGRAM` line and no remote image; the source stays in the message so copy still gets the Mermaid text.
### Todo list

- A **Todo list** belongs to one checkout; every chat in that checkout shares it, and a linked worktree has its own.
- Both **Plan mode** and **Build mode** may update the **Todo list**.
- An update is a full replace through a single `FAROL_TODOS:` line placed before the turn's final marker; an empty array clears the list, and a missing or malformed line leaves the list unchanged.
- The line is stripped from the visible Chat, and the update appears as a `todo` tool card.
- The current list is injected into every agent turn, so a fresh chat in the same checkout sees it.
- The **Todo list** is saved per checkout in application data, not in the repository, so it survives restarts and cleared chats and never joins a commit.
- Closing a checkout (removing the project from the workspace) deletes its **Todo list**; the checkout's saved chat session is unaffected.
- Clearing a chat does not clear the **Todo list**.
- Chat shows the list as a collapsible dock **above the composer** (not in the transcript): collapsed state shows completed/total progress plus the active item (in-progress, else pending, else latest completed); expanded state is a compact checklist with strikethrough for completed and cancelled items. Manual add, edit, run, cancel, and delete remain available there.
- **Execute plan** does not reset or re-own the list; Plan-to-Build keeps the same checkout list.

## Example dialogue

### Source Control page

> **Dev:** "Should the rail Git button still open the 360px popover, with the screenshot as a separate page?"
> **Domain expert:** "No. Replace the popover. One Git UI: a Settings-style full-page overlay, same hook and actions."
>
> **Dev:** "The screenshot also has a pipeline step rail. Is that part of Source Control?"
> **Domain expert:** "No. Only the version-control widgets from the screenshot. Do not add pipeline chrome to this page."
>
> **Dev:** "Do the **Changes** checkboxes run `git add`, or only pick files for the next commit?"
> **Domain expert:** "**Commit selection**. No stage/unstage UI. Stage all means select every committable file."
>
> **Dev:** "Does **Generate with AI** still see every committable file?"
> **Domain expert:** "No. Only the **Commit selection**, so the message matches what Commit includes."
>
> **Dev:** "Must the user Generate before Commit is available?"
> **Domain expert:** "No. Generate is optional. Commit uses the current text and the current **Commit selection**."
>
> **Dev:** "Are Compare, Base, and the PR title real create inputs?"
> **Domain expert:** "Compare is this branch. Base and title are real: Base picks the `--base` target from the known base, local branches, and remote-tracking branches (minus this branch), and title passes `--title` when non-empty. Keep hold-to-confirm and `--fill`; never default Base to the current branch."
>
> **Dev:** "Is **Check conflicts** a new action, or today's Resolve with AI?"
> **Domain expert:** "The same action, always visible. Relabel. Keep two-click confirm and the current block reasons. **Merge status** is unknown until GitHub or base-merge has loaded."
>
> **Dev:** "When **Changes** first load, which checkboxes are on?"
> **Domain expert:** "All committable files. Same default as today's commit-everything path."
>
> **Dev:** "When status reloads every few seconds, do those checkboxes reset?"
> **Domain expert:** "No. Keep the user's checks. New committable files start on; gone paths drop."
>
> **Dev:** "If the user unchecks a file, or a new file appears after Generate, is Commit blocked until they generate again?"
> **Domain expert:** "Never. That stale-draft check goes away. Commit uses the current text and the current **Commit selection**."
>
> **Dev:** "If every **Changes** checkbox is off but the tree is still dirty, can they Commit?"
> **Domain expert:** "No. Disable Commit until at least one committable file is checked. Do not create an empty commit."
>
> **Dev:** "Is **Git log** a fetch history, or the old success/error banners?"
> **Domain expert:** "An action transcript. Append commit, push, create PR, **Check conflicts**, and refresh-failure outcomes with a time. Drop the single banners. Do not add fetch."
>
> **Dev:** "How long should **Git log** lines live?"
> **Domain expert:** "On the hook for the session. Same as today's lastMessage/error — survive closing Git, reset on project switch, not saved to disk."
>
> **Dev:** "With an always-visible box, how long should the typed or generated **Commit message** live?"
> **Domain expert:** "Same as today's draft. Survive closing Git, reset on project switch, clear after a successful commit, not saved to disk."
>
> **Dev:** "The screenshot box has no Cancel. Today Cancel hides the draft and drops the text. Keep it?"
> **Domain expert:** "Drop it. The box stays. Edit or clear the text; Generate replaces it; closing the page still keeps the message."
>
> **Dev:** "If the user closes and reopens Source Control, do the **Changes** checkboxes reset?"
> **Domain expert:** "No. Same session as the **Commit message** and **Git log**. First load is the first status for this project this session."
>
> **Dev:** "If status keeps failing every few seconds, does **Git log** get a line each time?"
> **Domain expert:** "No. One line per failure streak. Append when a refresh fails after a success, or on the first fail. Stay quiet while it keeps failing. Do not log successful polls."
>
> **Dev:** "Generate with AI failures used the error banner. Where do they go now?"
> **Domain expert:** "**Git log**. Append the failure. Do not bring back a banner. Do not log a successful generate."
>
> **Dev:** "Today commit stages every committable file, then `git commit` with no pathspec. If a file is unchecked but already staged, that commit still includes it. How should Commit apply **Commit selection**?"
> **Domain expert:** "Make the index match the selection. Stage the checked files, take other committable files out of the index, then commit. Do not leave an unchecked staged file in the commit."
>
> **Dev:** "If Commit unstages an unchecked file and then the commit fails, does that file stay unstaged?"
> **Domain expert:** "No. Put it back. Restore previously staged unchecked files. Keep today's rollback for files this attempt newly staged."
>
> **Dev:** "How should those restored files re-enter the index? This app has no hunk UI."
> **Domain expert:** "Whole-file `git add` of each restored path. An index snapshot would keep partial hunks, but that is new git machinery."
>
> **Dev:** "Today the pane splits Staged / Not staged / New / Conflicts, and commit skips secrets. Which paths get a **Changes** row?"
> **Domain expert:** "**Committable file** only. Unique staged, unstaged, and untracked paths, minus secrets. No conflict rows. Secrets stay out of **Commit selection** the same way they stay out of today's commit."
>
> **Dev:** "**Changes** has no conflict checkboxes. Where do working-tree and predicted conflict paths go?"
> **Domain expert:** "Keep today's lists on the **Pull request** block. **Merge status** text stays. Do not hide the paths."

### Plan mode

> **Developer:** "Can the agent inspect the existing implementation in Plan mode?"
> **Domain expert:** "Yes, and it can ask questions and propose changes, but it cannot apply those changes while Plan mode is selected."

> **Developer:** "Can I select Plan mode with Claude?"
> **Domain expert:** "Yes. Claude, Codex, Cursor, OMP, OpenCode, and OpenRouter can all use Plan today — OpenRouter rides the OpenCode CLI, so it inherits OpenCode's review gate."

> **Developer:** "If a provider had no review gate, would the Plan | Build switch disappear?"
> **Domain expert:** "No. Both sides stay. Plan would be disabled — visible but not selectable — with a tooltip explaining why."

> **Developer:** "How do I find out why Plan is unavailable?"
> **Domain expert:** "Hover or focus the Plan side. The tooltip there names the provider and says it cannot enforce read-only. Nothing else in Chat announces it."

> **Developer:** "Cursor has its own plan mode. Does Farol use that?"
> **Domain expert:** "Yes now — Farol Plan drives each provider's own read-only mode, including Cursor's native `--mode=plan`, Claude's `--permission-mode plan`, and OpenCode's `--agent plan`."

> **Developer:** "If Plan is selected and I switch to a provider that cannot enforce read-only access, what happens?"
> **Domain expert:** "Farol switches the Chat to Build. Plan cannot stay selected. If a finished plan still has Execute, it stays."

> **Developer:** "Farol switched me to Build because that provider could not enforce read-only. If I pick a provider that can, does Plan come back?"
> **Domain expert:** "No. You stay in Build until you select Plan yourself."

> **Developer:** "Where do I choose Plan or Build?"
> **Domain expert:** "A Plan | Build switch inside the Chat input, on the bottom left. It replaces Clear chat there. Clear chat stays on the last assistant footer and the project rail."

> **Developer:** "What do I select when I want the agent to change files?"
> **Domain expert:** "Build."

> **Developer:** "If I clear this Chat, will it stay in Plan mode?"
> **Domain expert:** "No. Clearing starts a new Chat, and a new Chat starts in Build."

> **Developer:** "Does finishing a plan start implementation?"
> **Domain expert:** "No. Plan mode stays on. I can click Execute to switch to Build and start implementation, or switch to Build myself."

> **Developer:** "If I restart Farol and reopen this Chat, will Plan mode still be selected?"
> **Domain expert:** "Yes. Each Chat remembers its selected mode."

> **Developer:** "Can I change modes while the agent is responding?"
> **Domain expert:** "No. Wait for the response to finish or stop it before changing modes."

> **Developer:** "The agent is working in Plan on Codex. I switch to Claude because of a usage limit. Does Plan stay until the response finishes?"
> **Domain expert:** "No. Farol switches you to Build immediately. The lock only stops you from picking a mode, not Farol from leaving Plan when the new provider has no review gate."

> **Developer:** "If I restart Farol before executing a finished plan, can I still execute it when I reopen the Chat?"
> **Domain expert:** "Yes. Its Execute button is restored as long as it is the latest unexecuted finished plan and I have not sent a follow-up."

> **Developer:** "After the agent revises a plan, can I still execute the earlier version?"
> **Domain expert:** "No. Only the latest plan has an active Execute button."

> **Developer:** "If I request a revision and then cancel it, can I execute the earlier plan?"
> **Domain expert:** "No. Requesting the revision immediately removes its Execute button, and cancellation or failure does not restore it."

> **Developer:** "If I only ask why the agent chose an approach, can I still execute the earlier plan?"
> **Domain expert:** "No. Every follow-up message immediately removes its Execute button; the agent must explicitly finish a new plan before Execute is available again."

> **Developer:** "Does every reply in Plan mode get an Execute button?"
> **Domain expert:** "No. The agent must emit FAROL_PLAN: finished as the last line of the reply. Without that exact last line, there is no Execute button."

> **Developer:** "Does a finished plan still need to end with FAROL_PIPELINES or FAROL_QUESTIONS?"
> **Domain expert:** "No. In Plan mode that last-line pair is replaced. A finished plan ends with FAROL_PLAN: finished only."

> **Developer:** "If the agent needs a decision while planning, does it still ask with FAROL_QUESTIONS?"
> **Domain expert:** "Yes. Questions stay. That reply is not a finished plan, so there is no Execute button."

> **Developer:** "If the agent only reports what it found and is not finishing a plan, what is the last line?"
> **Domain expert:** "FAROL_PIPELINES: [] — empty. That is not a finished plan."

> **Developer:** "If a Plan-mode reply ends with FAROL_PIPELINES listing real pipeline IDs, does Farol run them?"
> **Domain expert:** "No. Plan mode never runs pipelines. The reply still appears; those IDs are ignored."

> **Developer:** "If implementation fails or I cancel it after clicking Execute, does that plan's Execute button return?"
> **Domain expert:** "No. The button stays consumed; I can send a follow-up in Build to continue implementation or select Plan mode again to request a new plan."

> **Developer:** "If I switch to Build myself without clicking Execute, can I still execute the finished plan?"
> **Domain expert:** "Yes. The Execute button stays until I click it or send a follow-up."

> **Developer:** "Where do I click Execute after a finished plan?"
> **Domain expert:** "On the plan message itself — not in the composer, the header, or a banner."

> **Developer:** "Where on that message is the button?"
> **Domain expert:** "Below the plan."

> **Developer:** "What will I see in the Chat when I click Execute?"
> **Domain expert:** "A user message that says Execute the plan, then the agent starts implementing in Build."

> **Developer:** "If I type Execute the plan in the composer myself, does that start implementation?"
> **Domain expert:** "No. Only the Execute button does. Those words are an ordinary follow-up, so the earlier plan also loses its Execute button."

### Agent Git actions

> **Dev:** "Why can't the agent just run `git commit` in its shell?"
> **Domain expert:** "It asks Farol with **FAROL_GIT** instead. Farol performs the action inside the app, so it can be gated by a pipeline and shows up in the **Git panel**."

> **Dev:** "What actually compels it to commit?"
> **Domain expert:** "The **Managed-chat contract**. A turn that changed files generates a commit message and requests a commit through **FAROL_GIT**."

> **Dev:** "Which files go in that commit?"
> **Domain expert:** "Files changed this turn. Not the user's **Commit selection** — that still belongs to the **Source Control page**."

> **Dev:** "How do I stop the agent committing?"
> **Domain expert:** "Turn off the **Git actions toggle** in Settings. It is one switch for this machine, not per project."

> **Dev:** "Does that also stop a pull request?"
> **Domain expert:** "Yes. Status, commit, push, and create pull request all pass through it."

> **Dev:** "How is this hooked to a pipeline?"
> **Domain expert:** "Bind a **Git hook pipeline** to the action in `.farol`. It runs as a gate: pass, the action runs; fail, it does not and the agent gets the failure."

> **Dev:** "Is that a `.git/hooks` script?"
> **Domain expert:** "No. Farol still performs the action; the pipeline only gates it."

> **Dev:** "If the hook passes, does the agent still select that pipeline with **FAROL_PIPELINES**?"
> **Domain expert:** "No. The hook is chosen by `.farol` per action. The turn's own **FAROL_PIPELINES** validation is separate."

> **Dev:** "Can the agent commit while I'm in Plan mode?"
> **Domain expert:** "No. Plan mode is read-only, so a **FAROL_GIT** line is ignored — the same as a non-empty **FAROL_PIPELINES** list."

> **Dev:** "Will I see the agent's commit in the Git page?"
> **Domain expert:** "Yes. The existing **Git panel** shows it and the **Git log** records the outcome."

> **Dev:** "Can an agent in a terminal pane use these too?"
> **Domain expert:** "Yes, through the **Git tools** — `git_status`, `git_commit`, `git_push`, `git_create_pr` — over the bridge to the running app."

### Chat diagram

> **Developer:** "When does Chat show a diagram of the work?"
> **Domain expert:** "When the agent proposes a plan, and again after it changes files. Both are **Chat diagrams** — Mermaid in the message, rendered in place."

> **Developer:** "Does every reply need one?"
> **Domain expert:** "No. Skip questions-only and status-only turns. The diagram is for the approach and for what changed."

> **Developer:** "Is that a new control line?"
> **Domain expert:** "No. It is a ` ```mermaid ` fence. Copy still gets the source."
### Todo list

> **Developer:** "Which chat owns a todo list?"
> **Domain expert:** "The checkout. Every chat on that checkout shares one list, and a worktree has its own."

> **Developer:** "Can a Plan-mode chat update it?"
> **Domain expert:** "Yes. Plan and Build both may, though Plan still cannot change files."

> **Developer:** "How does the agent update it?"
> **Domain expert:** "With a single `FAROL_TODOS:` line before its final marker. It replaces the whole list; `FAROL_TODOS: []` clears it."

> **Developer:** "What if the line is malformed?"
> **Domain expert:** "Ignore it and keep the list. It is not worth retrying the turn."

> **Developer:** "Does clearing a chat clear its todos?"
> **Domain expert:** "No. The list belongs to the checkout, so a new chat sees the same list."

> **Developer:** "Do todos survive a restart?"
> **Domain expert:** "Yes. They are saved per checkout in application data."

> **Developer:** "If I close and reopen the checkout, is the list still there?"
> **Domain expert:** "No. Closing the checkout drops its todo list. Reopening starts empty."

> **Developer:** "Would the list show up in Source Control?"
> **Domain expert:** "No. It is not stored in the repository, so it is never a committable file."

## Flagged ambiguities

### Source Control page

- "Source Control page" is the overlay chrome (full-page, Escape to close), not a new app route — resolved with the replace-popover decision.
- The screenshot’s right-hand pipeline stepper is existing workspace chrome, not a **Source Control page** widget — resolved with Screenshot VC only.
- File checkboxes / Stage all appear on **Changes**, but the current **Git panel** has no stage action and commits all committable files — resolved: **Commit selection**, not `git add`. The current `commitAll` path still stages every committable file and treats `files` as a staleness check only; that must change so a commit includes only the selected paths.
- **Generate with AI** currently drafts from every committable file — resolved: it sees the **Commit selection** only.
- Today Commit is disabled until a draft exists — resolved: **Typed commit**. Generate is optional.
- Screenshot Compare / Base look like pickers, and a title field looks like a create input — resolved: Compare is read-only, but Base and title are real create inputs. Base selects the `--base` target from the known base, local branches, and remote-tracking branches minus this branch; title passes `--title` when non-empty. Compare still does not check out a branch; create keeps `--fill`.
- Base could default to the current feature branch, because the local branch list is sorted by most recent commit — resolved: the current branch is excluded, and the default is the known base, else `staging` / `main` / `master` / `develop`, else the repository default. Remote-only bases such as `origin/staging` are offered by branch name too.
- Today Resolve with AI appears only when a conflict signal exists — resolved: **Check conflicts** is always visible, same two-click confirm and block reasons. **Merge status** stays unknown until GitHub or base-merge has loaded.
- The screenshot’s mixed **Changes** selection (package.json off) is a later user edit, not the first-load default — resolved: all committable files start selected.
- Status reloads while the page is open would otherwise re-check every file — resolved: keep the user's **Commit selection**, select newly appeared committable files, drop gone paths.
- Today Commit is blocked when the draft file list is not exactly every committable file — resolved: never. A generated list is a snapshot for **Generate with AI**, not a later gate. A newly appeared auto-checked file can be committed with a message that did not see it.
- Today Commit is blocked only for a clean tree, conflicts, or secrets-only — resolved: also disable when **Commit selection** is empty. A dirty tree with every checkbox off is not a commit.
- The screenshot **Git log** mock is a fetch line; today’s pane has one success banner, one error banner, and no fetch — resolved: **Git log** is an action transcript of existing outcomes only. Drop the banners. Do not add fetch.
- Today’s lastMessage/error live in `useGitPanel`, survive closing Git, reset on project switch, and are not saved to disk — resolved: **Git log** uses that same session lifetime and replaces those banners.
- Today’s **Commit message** draft has that same session lifetime and is cleared after a successful commit — resolved: the always-visible box keeps that lifetime. It is not a new persisted field.
- Today Cancel hides the draft box and drops the text — resolved: drop Cancel. The always-visible box is the only editor.
- **Commit selection** checkboxes could have reset on close — resolved: they live on the **Git panel** for the session, same as the **Commit message** and **Git log**. First load is the first status for this project this session, not each reopen.
- Status reloads about every 5s while the page is open — resolved: refresh-failure **Git log** lines are one per streak, not one per poll. Successful refreshes are silent.
- Generate with AI failures used the error banner — resolved: they append to **Git log**. A successful generate is not a line.
- Today `commitAll` stages every committable file, then `git commit` with no pathspec — resolved: **Index matches selection**. An unchecked file that was already staged is taken out of the index before commit. A pathspec commit that left leftover staged files in the index would still include them.
- Today a failed commit only unstages files this attempt newly staged — resolved: also restore unchecked files that were staged before the attempt. The working tree should look like it did before Commit, except for anything the failed `git commit` itself changed.
- Restore could snapshot the index to keep partial hunks — resolved: whole-file `git add` of each restored path. This app already stages whole files and has no hunk UI.
- Today’s pane splits Staged / Not staged / New / Conflicts, and commit skips secret-looking files — resolved: **Changes** lists **committable file** paths only. No conflict rows. Secrets stay out of **Commit selection** the same way they stay out of today’s commit.
- Conflict paths would otherwise disappear once **Changes** is committable-only — resolved: keep today’s working-tree and predicted lists on the **Pull request** block. **Merge status** text stays. Do not hide the paths.

### Plan mode

- Resolved: **Plan mode** means read and plan, rather than permission to implement a plan.
- Resolved: the earlier manual-switch-only decision is superseded by **Execute plan**, which combines switching to **Build mode** with requesting implementation; selecting **Build mode** manually remains available.
- Resolved: the Chat input calls the writable mode **Build**, not Agent or Implement. "Build" also describes compile and pipeline work in this product; here **Build mode** is only the Chat permission to change the project.
- Resolved: a new Chat starts in **Build mode**. Clearing a conversation is a new Chat, so it also starts in **Build mode**; Plan is opt-in.
- Resolved: selecting **Build mode** manually does not consume **Execute plan**; only a follow-up message or selecting **Execute plan** does.
- Resolved: switching to a provider that cannot enforce read-only access while **Plan mode** is selected switches the Chat to **Build mode**; it does not consume **Execute plan**.
- Resolved: Farol does not restore **Plan mode** after that forced switch; selecting a capable provider later leaves the Chat in **Build mode** until the developer selects **Plan mode**.
- Resolved: **Plan mode** and **Build mode** are chosen with a switch inside the Chat input, on the bottom left — not a toolbar control, settings default, or composer menu.
- Resolved: that switch is a **Plan | Build** control with two labeled sides, not a single toggle, dropdown, or icon-only control.
- Resolved: the **Plan | Build** switch replaces the Clear chat control on the bottom left of the Chat input, rather than sitting beside it or moving Clear chat elsewhere in the input.
- Resolved: after that replacement, Clear chat remains on existing surfaces only — the last assistant footer and the project rail — and is not added to a new Chat surface.
- Resolved: **Execute plan** is offered on the **Finished plan** message, not from the Chat input, the Chat header, or a banner.
- Resolved: that button sits below the plan content, not beside it or in the assistant footer.
- Resolved: selecting **Execute plan** creates an **Execute message** whose text is always “Execute the plan”; the developer does not write a separate implementation prompt.
- Resolved: the composer cannot start implementation by sending that same text; only the Execute button is **Execute plan**. Typed “Execute the plan” is a follow-up, so it also removes the earlier plan’s Execute button.
- Resolved: Farol tells a Plan-mode reply is a **Finished plan** from a hidden control line the agent emits, not from reading the plan as prose.
- Resolved: that hidden control line is exactly `FAROL_PLAN: finished`. No other wording or `FAROL_PLAN:` value marks a **Finished plan**.
- Resolved: `FAROL_PLAN: finished` marks a **Finished plan** only as the last line of the reply. The same line earlier in the message does not.
- Resolved: In Plan mode, `FAROL_PLAN: finished` replaces the FAROL_QUESTIONS / FAROL_PIPELINES last-line contract for a Finished plan; it is not added alongside them.
- Resolved: In Plan mode, decision turns still end with FAROL_QUESTIONS. Only a Finished plan uses `FAROL_PLAN: finished` as its last line.
- Resolved: In Plan mode, a reply that is neither a question nor a **Finished plan** ends with `FAROL_PIPELINES: []`.
- Resolved: A non-empty `FAROL_PIPELINES` list in Plan mode does not start validation; Plan mode never runs pipelines.
- Resolved: That reply is accepted and shown; Farol ignores the listed IDs instead of rejecting the turn or asking the agent to retry.
- Resolved: Enforcing read-only access for **Plan mode** means a **Review gate** — the same enforcement pipeline reviews already use — not a prompt. Providers without a **Review gate** cannot use **Plan mode**.
- Resolved: Farol Plan drives each provider's own native read-only mode: Codex's `--sandbox read-only`, Cursor's `--mode=plan`, OMP's read-only tool allowlist, Claude's `--permission-mode plan`, and OpenCode's `--agent plan`.
- Resolved: A forced switch to **Build mode** because the new provider has no **Review gate** still applies while the agent is working; the mode-selector lock does not defer it.
- Resolved: When the current provider has no **Review gate**, Farol disables the Plan side of the **Plan | Build** switch. The switch stays visible with both labels; Plan is not hidden and is not left clickable.
- Resolved: That explanation lives in a tooltip on the disabled Plan side, not in a banner, toast, status line, or other Chat surface.
- Resolved: That tooltip names the current provider and the reason Plan is unavailable, rather than a generic unavailable message.
- Resolved: That reason’s exact wording is “Cannot enforce read-only”, not a mention of **Review gate** or a longer explanation.

### Agent Git actions

- Exposing "the git tools like the pipelines" could mean a second Git API — resolved: **Git actions** reuse the existing **Git panel** actions; status, commit, push, and create pull request.
- Managed Chat cannot call the Farol MCP tools today — resolved: it requests a **Git action** with the **FAROL_GIT control line**; the **Git tools** are the MCP path for terminal and other clients.
- What compels the model to commit could be a per-turn reminder — resolved: the **Managed-chat contract** carries it, alongside the existing `FAROL_QUESTIONS` / `FAROL_PIPELINES` rules.
- "The agent commits its work" could reuse the user's **Commit selection** — resolved: an **Agent commit** uses only the files the turn changed. The page's Commit still uses **Commit selection**.
- The first answer chose a per-project on/off switch — resolved: the **Git actions toggle** is a master switch for the machine, with no per-project override.
- "git hook" sounds like `.git/hooks` or a post-commit script — resolved: a **Git hook pipeline** is a Farol pipeline bound per action in `.farol`, and it gates before Farol performs the action.
- The agent has a shell and could run git directly — resolved: for these actions it asks Farol, so the pipeline gate and the **Git panel** history apply.
- A **Git action** and the turn's `FAROL_PIPELINES` validation could be conflated — resolved: the hook pipeline is chosen by `.farol` per action, the agent does not select it, and ordinary validation still runs.
- The agent's **Git action** could be invisible to the UI — resolved: it appears on the existing **Git panel**, and the **Git log** records its outcome.
- Plan mode could still allow status (read-only) — resolved: **Plan mode** performs no **Git action**; a `FAROL_GIT` line there is ignored the way a non-empty `FAROL_PIPELINES` list is.

### Chat diagram

- Explaining a change could mean a new control line or a remote image — resolved: a **Chat diagram** is a ` ```mermaid ` fence in the message; Chat renders it, and the contract asks for one before implementation and after file changes.
### Todo list

- The **Todo list** could hang off a chat, a repository, or a checkout — resolved: per checkout, so a linked worktree keeps its own list and every chat on a checkout shares one.
- OpenCode exposes `todowrite` as an MCP tool, but managed Chat runs each CLI with project MCP disabled (see `managedAiCommand`), so a tool call is not available — resolved: a `FAROL_TODOS:` control line, the same channel as questions and pipeline selection.
- An update could be a patch or a full replace — resolved: full replace, like OpenCode's `todowrite`; an empty array clears the list.
- A malformed update could fail the turn the way an invalid pipeline selection does — resolved: ignore it and keep the previous list. A todo typo is not worth a repair cycle.
- The list could live in `.farol/todos.json` with the pipelines — resolved: application data keyed by checkout, so it is not committed and cannot appear as a **committable file**.
- “Delete checkout” as the removal trigger could mean the folder disappearing — resolved: closing the checkout (removing the project from the workspace) deletes its list, while the checkout's saved chat session is left alone.
- A cleared chat is a new **Chat** — resolved: it does not clear the **Todo list**, which belongs to the checkout.
- The list could be shown only to the agent — resolved: each update also appears as a `todo` tool card, and the current list is injected into every turn.

### Jev pipeline auto-selection

- Jev could be asked about every non-mandatory catalog pipeline — resolved: only pipelines with **Allow Chat to auto-select** (`autoSelectable`) are offered; the flag defaults to off so release/mutation pipelines stay manual.
- A mid-range probability (for example 0.3) could be treated as inconclusive the way step verdicts are — resolved: selection is one Choice over opted-in candidates plus `none`; the winner applies only when prepared and `probability >=` the selection threshold (anything lower, `none`, or an unknown id is do-not-add).
- Questions that name only the pipeline id leave Jev guessing what the pipeline does — resolved: each Choice option includes a compact, length-capped description of step names, types, and command/prompt excerpts.
- The decision state was only the task prompt plus assistant text — resolved: it also includes changed write targets and compact definitions of already-selected and mandatory pipelines so redundancy can be judged; that state is never written to Jev logs.
- Below-threshold selection scores were logged as `inconclusive` — resolved: logs use Choice outcomes (`selected` / `none` / `not-selected` / `low-confidence` / `unknown-id`) with candidate metadata and a state size summary, not prompts or secrets.
- Independent booleans per candidate could over-add — resolved: one relative Choice with a `none` escape hatch; the host re-checks the returned id against the prepared set.

### Jev tool focus selection

- Managed Chat could ship every CLI with its full default tool set — resolved: before each turn Jev picks one host-prepared focus; Build uses `inspect` / `implement` / `verify` / `answer`, Plan uses only read-only `inspect` / `answer`.
- Uncertain scores could strand a coding turn — resolved: Build mid-band, unknown id, fingerprint drift, timeout, and missing key fail open to the full tool set; Plan soft-fails to `inspect` so optional families never open.
- Absolute yes/no per optional family (`edit` / `shell` / `web`) does not compete — resolved: one Choice over foci; the host maps the focus to kept/omitted families and re-validates before native `--tools` or the prompt clause.
- Plan mode could skip tools entirely — resolved: Plan uses read/search tools under a read-only focus; `inspect` may use web search/fetch for research; edit and mutating shell stay off; provider review gates stay the hard write block.
- Prompt-policy violations could kill the run mid-tool — deferred: v1 logs omitted-family tool cards for diagnosis only.
