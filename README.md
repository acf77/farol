# Farol

A desktop terminal workspace with runnable pipelines. Open a project folder, get
shell tabs backed by your machine's own default shell, and run named pipelines
whose steps are real commands — or prompts handed to Claude, Codex, Cursor, or
OpenCode — streaming into their own tab.

Implemented from the `Farol.dc.html` design spec in the
[Farol App Design Spec](https://claude.ai/design/p/e5f280c0-b106-4b8d-b38c-a92c4f18a3bb)
Claude Design project.

## Running it

```bash
npm install     # also rebuilds node-pty against Electron's ABI
npm run dev     # dev build with HMR for the renderer
npm run build   # production build into out/
npm start       # alias for electron-vite preview
npm run dist         # Mac .dmg + .zip into dist/, publish local update feed
npm run install:app  # same, then replace /Applications/Farol.app
npm test             # unit tests for the terminal parser
npm run typecheck
```

After the first install, new builds do not need another DMG. `npm run dist` writes the
update into `~/.farol/updates`; the running app notices and offers **Restart to
update** (or Farol → Check for Updates…). Quit and relaunch once if you are
still on the original 0.1.0 build — that version cannot self-update.

**Upgrading from BuildFlow:** the rename changed the app id, bundle name, and
update feed (`~/.buildflow/updates` → `~/.farol/updates`). An installed
BuildFlow build cannot self-update to Farol — run `npm run install:app` (or
open the DMG and drag Farol into Applications). `install:app` also removes
`/Applications/BuildFlow.app` if it is still present. Opening a project in Farol
migrates `.buildflow/pipelines.json` into `.farol/` and replaces the old
`buildflow` MCP entry with `farol`. Recents and the last workspace layout are
copied once from the old Application Support folder (`BuildFlow` / `buildflow`)
into Farol's userData when those files are not already present.

To install the packaged app the first time, open the DMG in `dist/` and drag
Farol into Applications, or run `npm run install:app`. The build is ad-hoc
signed; on first launch, right-click the app and choose Open.

## How it works

```
electron/
  main.ts      window, application menu, IPC
  shell.ts     raw PTYs for shell panes, forwarded to xterm.js
  session.ts   scripted shell session used by pipeline steps
  git.ts       branch info, checkout, HEAD watching
  runner.ts    pipeline execution, streamed as events
  store.ts     pipelines on disk, recents, last workspace
  preload.ts   the contextBridge API surface
shared/types.ts   contract shared by main, preload and renderer
src/
  App.tsx      state: tabs, panes, runs per branch
  layout.ts    pane split tree and geometry (tested)
  ansi.ts      parser for pipeline step output (tested)
  components/  Toolbar, TabStrip, PaneGrid, XtermPane, LogPane, Sidebar…
```

### Shell panes are real terminals

Each pane runs your default shell (`$SHELL`, falling back to the passwd entry)
as an interactive login shell on a PTY, wired to **xterm.js** — the same
terminal emulator VS Code and Hyper embed. Farol does not interpret the
byte stream at all, so a pane behaves like a window of your own terminal:

- your prompt, your theme, your aliases, your PATH — `.zprofile` and `.zshrc`
  are sourced exactly once per pane;
- full-screen programs work, because xterm gives them a real screen buffer with
  an alternate screen, cursor addressing and scroll regions — an interactive
  agent, `vim`, `less`, `htop` all render properly;
- keystrokes, Ctrl-C, mouse reporting and resize go straight through.

Panes report their directory via OSC 7 when the shell emits it, which is what
the title bar shows after a `cd`.

### Splits

A tab holds a binary tree of panes (`src/layout.ts`, pure and unit-tested).
`⌘D` splits the focused pane to the right, `⇧⌘D` splits it downwards, and each
new pane gets its own shell starting in the same directory. Drag the divider
between panes to resize (clamped to 15–85%); `⇧⌘W` closes a pane, and closing
the last one closes the tab. Once a tab is split, panes get a title bar and the
focused pane is outlined.

### Branches

When the project is a git repository the status bar shows the current branch,
kept in step with a watch on `.git/HEAD`. Parallel branch work lives in the
**Projects** rail: each open folder is a checkout, and same-repo worktrees nest
under one repo group. The branch icon on a group (or the status-bar branch)
opens another branch as its own project via a git worktree — a sibling folder —
so an agent already working here is not disrupted. Type a name in the dialog to
create a new branch that way. If git refuses (uncommitted changes) the message
is shown rather than swallowed.

Runs are tracked **per branch**. A pipeline that passed on `main` shows as
"Not run on feature/x" after you switch, with the earlier result listed under
"Other branches", and each run tab is tagged with the branch it ran on — amber
once the checkout has moved on.

### Pipelines

A pipeline is a named list of steps, each either `SHELL` (a command) or `AI` (a
prompt). Runs are sequential and a failing step short-circuits the rest, which
are marked skipped. Output streams into a tab named after the pipeline; closing
that tab stops watching without cancelling the run.

- **Shell steps** run through one persistent session in the focused pane's
  directory — a login shell driven by a sentinel prompt, so each step reports a
  real exit code while sharing the environment you'd have by hand. On a worktree
  tab, that's the worktree, not the original checkout.
- **AI steps** shell out to the CLI chosen on the step — Claude (`claude -p`),
  Codex (`codex exec`), Cursor (`agent -p`), OpenCode (`opencode run`), or
  OpenRouter (OpenCode plus a saved key) — and are handed the run's output so
  far as context. If that CLI isn't on PATH the step fails with a note saying so.

OpenRouter is configured in **Settings** (toolbar gear, File menu, or ⌘,):
paste an API key, which Farol encrypts locally. Settings fetches tool-capable
models from OpenRouter’s catalog and pins a short recommended set for Chat and
pipeline pickers. The key is injected as `OPENROUTER_API_KEY` only into
Farol-spawned OpenCode processes — not into regular shell panes, and not into
OpenCode’s own auth file.

The editor is a node canvas. Steps are nodes you drag into position; wires
between them declare order, dragged from the port on one node's bottom edge to
the port on another's top. Middle-drag or hold space to pan, Cmd-scroll to
zoom. Selecting a node opens an inspector: step type, name, the command or (for
AI steps) a provider picker and a multi-line prompt field, and a **Gate**
toggle that decides whether a failure here skips everything downstream. The
detail pane in the sidebar shows the resulting order, annotated with what each
step did on the last run: `then` between steps, `and` where two run off the
same parent, `skipped` under the one that failed.

Pipelines are stored in the project itself, at `.farol/pipelines.json`, so
they can be committed and shared. A project without one is seeded with the four
starter pipelines from the design spec.

### Agent sessions

Open Chat from the toolbar, or **New agent terminal** from the command palette (⌘K):

- **Chat — enforced** runs the coding CLI through Farol's managed harness.
  The agent receives the current pipeline catalog and selects relevant
  pipelines when it finishes a code change (or `[]` when it changed nothing).
  Farol runs every selection directly; failures are fed into another repair
  turn, and the task is only marked complete after all selected pipelines pass
  — or immediately when none were selected. This does not depend on the
  provider granting its CLI permission to call Farol's MCP tools.
- **Terminal — MCP** opens Claude, Codex, Cursor, or OpenCode interactively in a
  real terminal. The Farol MCP server is available to list and run
  pipelines, but tool use is controlled by that external CLI and is therefore
  not enforced. Open Terminal from a Chat tab to place both side by side.

### Shortcuts

`⌘T` new tab · `⌘D` split right · `⇧⌘D` split down · `⌘W` close tab ·
`⇧⌘W` close pane · `⌘1–9` jump to tab · `⌘O` open project. Everything else —
`⌃C`, history, completion — is handled by the shell itself, as it should be.

The window is frameless; the traffic lights in the toolbar are wired to close,
minimise and zoom.

Closing the app remembers the last project, its shell tabs (including worktree
tabs), and how those tabs were split. Reopening restores that layout; shells
start fresh in the same directories. **Close Project** forgets which folder to
reopen, but keeps that project's layout for the next time you open it.
