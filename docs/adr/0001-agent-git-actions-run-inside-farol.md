# Agent Git actions run inside Farol, gated by pipelines

Agents already work in a Git checkout, and Farol already runs pipelines for them. We want the agent to commit a turn's changes — and optionally push or open a pull request — with the same visibility and hookability as a pipeline, rather than running git in its own shell.

We decided that managed Chat requests a **Git action** with a `FAROL_GIT:` control line (agents outside managed Chat use the `git_status` / `git_commit` / `git_push` / `git_create_pr` MCP tools), the action executes inside the running app through the existing bridge, and when `.farol` binds a **Git hook pipeline** to that action Farol runs it as a gate first: on pass the action runs, on fail it does not and the failure returns to the agent. A machine-scoped Settings **Git actions toggle**, on by default with no per-project override, can refuse every agent Git action.

We rejected letting the agent run `git` itself (nothing gates it and the app cannot show it), adding provider-approval MCP tool calls to managed Chat (approval varies by provider, and the managed harness owns execution), and reusing the user's **Commit selection** for the agent's commit (that selection is the Source Control page's, not the turn's changes).

Consequences: Farol owns git execution, so a **Git action** shows on the existing **Git panel** and the **Git log**, and the pipeline gate applies before it. An **Agent commit** contains only the files the turn changed. Plan mode ignores `FAROL_GIT` because it is read-only. The toggle is per machine, so a user cannot disable agent commits for one repository without disabling them everywhere.
