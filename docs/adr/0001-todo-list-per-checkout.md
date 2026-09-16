# Todo lists are stored per checkout in application data, updated by a control line

OpenCode exposes its todo list as an MCP `todowrite` tool, but Farol's managed Chat runs every CLI with project MCP disabled (`managedAiCommand`), so a managed agent cannot call a tool. We decided the todo list is owned by a checkout (a linked worktree has its own, every chat on a checkout shares one) and updated through a hidden `FAROL_TODOS:` control line — the same channel as `FAROL_QUESTIONS` and `FAROL_PIPELINES`. The list is persisted in application data keyed by checkout path, not in `.farol`, so it survives restarts and cleared chats, never joins a commit, and is deleted when the checkout leaves the workspace.

Considered and rejected: an MCP tool (unavailable to managed Chat, and only some providers load project MCP); per-chat ownership (a new chat or a cleared chat would lose the list); `.farol/todos.json` (would appear as a committable file).
