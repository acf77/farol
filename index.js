"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const pty = require("node-pty");
const os = require("os");
const child_process = require("child_process");
const fs$1 = require("fs/promises");
const bridge$1 = require("./chunks/bridge-CB8CLr5x.js");
const net = require("net");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const pty__namespace = /* @__PURE__ */ _interopNamespaceDefault(pty);
function killPidTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
    }
  }
  try {
    process.kill(pid, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
  } catch {
    try {
      process.kill(pid);
    } catch {
    }
  }
}
function killPty(proc) {
  if (!proc) return;
  killPidTree(proc.pid);
  try {
    proc.kill(process.platform === "win32" ? void 0 : "SIGKILL");
  } catch {
  }
}
const MARK_START = "BFL";
const MARK_END = "";
function shellFamily(shell) {
  const name = (shell.split(/[\\/]/).pop() || "").toLowerCase();
  if (process.platform === "win32") return "powershell";
  if (name.includes("zsh")) return "zsh";
  if (name.includes("bash")) return "bash";
  if (name.includes("fish")) return "fish";
  return "posix";
}
function quoteSh(cmd) {
  return `'${cmd.replace(/'/g, `'\\''`)}'`;
}
const PRINT_UNIX = `printf $'\\001BFL%s:%s\\002'`;
function unixRunFn() {
  return `__bf_run() { if eval "$1"; then ${PRINT_UNIX} "0" "$PWD"; else ${PRINT_UNIX} "$?" "$PWD"; fi; }; ${PRINT_UNIX} "0" "$PWD"`;
}
function initScript(family) {
  switch (family) {
    case "zsh":
      return `unsetopt zle 2>/dev/null; setopt no_errexit 2>/dev/null; stty -echo 2>/dev/null; PROMPT=''; RPROMPT=''; PS1=''; PS2=''; ` + unixRunFn() + "\n";
    case "bash":
    case "posix":
      return `set +e 2>/dev/null; stty -echo 2>/dev/null; PS1=''; PS2=''; ` + unixRunFn() + "\n";
    case "fish":
      return `stty -echo 2>/dev/null; function __bf_run; eval $argv; printf \\x01BFL%s:%s\\x02 $status $PWD; end; printf \\x01BFL%s:%s\\x02 0 $PWD
`;
    case "powershell":
      return `function __bf_run($c) { Invoke-Expression $c; $ec = if ($?) { 0 } else { 1 }; [Console]::Write([char]1 + 'BFL' + $ec + ':' + $PWD.Path + [char]2) }; [Console]::Write([char]1 + 'BFL0:' + $PWD.Path + [char]2)
`;
  }
}
function execScript(family, cmd) {
  switch (family) {
    case "fish":
      return `__bf_run ${quoteSh(cmd)}
`;
    case "powershell":
      return `__bf_run ${JSON.stringify(cmd)}
`;
    default:
      return `__bf_run ${quoteSh(cmd)}
`;
  }
}
function loginArgs(family) {
  return family === "powershell" ? ["-NoLogo", "-NoExit"] : ["-il"];
}
function partialSuffix(buf, marker) {
  const max = Math.min(buf.length, marker.length - 1);
  for (let n = max; n > 0; n--) if (buf.endsWith(marker.slice(0, n))) return n;
  return 0;
}
function feedMarks(buf) {
  let text = "";
  const marks = [];
  let rest = buf;
  for (; ; ) {
    const i = rest.indexOf(MARK_START);
    if (i === -1) break;
    const j = rest.indexOf(MARK_END, i);
    if (j === -1) {
      text += rest.slice(0, i);
      rest = rest.slice(i);
      return { text, marks, rest };
    }
    text += rest.slice(0, i);
    const payload = rest.slice(i + MARK_START.length, j);
    const sep = payload.indexOf(":");
    const code = parseInt(sep === -1 ? payload : payload.slice(0, sep), 10);
    const cwd = sep === -1 ? "" : payload.slice(sep + 1);
    marks.push({ code: Number.isFinite(code) ? code : 0, cwd });
    rest = rest.slice(j + MARK_END.length);
  }
  const keep = partialSuffix(rest, MARK_START);
  text += rest.slice(0, rest.length - keep);
  rest = rest.slice(rest.length - keep);
  return { text, marks, rest };
}
const isWindows = process.platform === "win32";
const READY_MS = 15e3;
function defaultShell() {
  if (isWindows) return process.env.COMSPEC || "powershell.exe";
  if (process.env.SHELL) return process.env.SHELL;
  try {
    const shell = os.userInfo().shell;
    if (shell) return shell;
  } catch {
  }
  return "/bin/sh";
}
function shellEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}
function pipelineEnv() {
  const env = shellEnv();
  env.PAGER = "cat";
  env.GIT_PAGER = "cat";
  env.POWERLEVEL9K_INSTANT_PROMPT = "off";
  return env;
}
class PtySession {
  constructor(opts) {
    this.opts = opts;
    this.cwd = opts.cwd;
    const shell = defaultShell();
    this.family = shellFamily(shell);
    this.proc = pty__namespace.spawn(shell, loginArgs(this.family), {
      name: "xterm-256color",
      cols: Math.max(20, Math.min(400, Math.floor(opts.cols ?? 100))),
      rows: 40,
      cwd: opts.cwd,
      env: pipelineEnv()
    });
    this.proc.onData((chunk) => this.consume(chunk));
    this.proc.onExit(({ exitCode }) => {
      this.alive = false;
      this.flushReady(false);
      const waiter = this.waiter;
      this.waiter = null;
      waiter?.resolve({ code: exitCode, cwd: this.cwd });
      const queued = this.queue.splice(0);
      for (const fn of queued) fn();
      this.opts.onEnd(exitCode);
    });
    this.proc.write(initScript(this.family));
  }
  proc;
  cwd;
  family;
  buf = "";
  started = false;
  waiter = null;
  queue = [];
  alive = true;
  readyResolvers = [];
  get isAlive() {
    return this.alive;
  }
  /** Resolves true once the shell has printed the ready marker. */
  whenReady(ms = READY_MS) {
    if (this.started) return Promise.resolve(true);
    if (!this.alive) return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.readyResolvers = this.readyResolvers.filter((r) => r !== done);
        resolve(false);
      }, ms);
      const done = (ok) => {
        clearTimeout(t);
        resolve(ok);
      };
      this.readyResolvers.push(done);
    });
  }
  flushReady(ok) {
    const rs = this.readyResolvers.splice(0);
    for (const r of rs) r(ok);
  }
  consume(chunk) {
    this.buf += chunk;
    const { text, marks, rest } = feedMarks(this.buf);
    this.buf = rest;
    if (text && this.started) this.opts.onData(text);
    for (const mark of marks) this.onMark(mark);
  }
  onMark(mark) {
    if (mark.cwd) this.cwd = mark.cwd;
    if (!this.started) {
      this.started = true;
      this.flushReady(true);
      const next = this.queue.shift();
      next?.();
      return;
    }
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.resolve({ code: mark.code, cwd: this.cwd });
    if (!this.waiter) this.queue.shift()?.();
  }
  exec(cmd) {
    return new Promise((resolve) => {
      const go = () => {
        if (!this.alive) {
          resolve({ code: 127, cwd: this.cwd });
          return;
        }
        this.waiter = { resolve };
        this.proc.write(execScript(this.family, cmd));
      };
      if (this.started && !this.waiter) go();
      else this.queue.push(go);
    });
  }
  write(data) {
    if (this.alive) this.proc.write(data);
  }
  interrupt() {
    if (this.alive) this.proc.write("");
  }
  resize(cols) {
    if (!this.alive) return;
    try {
      this.proc.resize(Math.max(20, Math.min(400, Math.floor(cols))), 40);
    } catch {
    }
  }
  kill() {
    if (!this.alive) return;
    this.alive = false;
    this.flushReady(false);
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.resolve({ code: 130, cwd: this.cwd });
    const queued = this.queue.splice(0);
    for (const fn of queued) fn();
    killPty(this.proc);
  }
}
const OSC7 = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
class ShellManager {
  constructor(onData, onExit, onCwd) {
    this.onData = onData;
    this.onExit = onExit;
    this.onCwd = onCwd;
  }
  sessions = /* @__PURE__ */ new Map();
  /** Commands aimed at a pane whose PTY has not started yet. */
  pending = /* @__PURE__ */ new Map();
  open(paneId, cwd, cols = 100, rows = 30) {
    const existing = this.sessions.get(paneId);
    if (existing) return;
    const shell = defaultShell();
    let proc;
    try {
      proc = pty__namespace.spawn(shell, process.platform === "win32" ? [] : ["-il"], {
        name: "xterm-256color",
        cols: Math.max(20, Math.min(500, Math.floor(cols))),
        rows: Math.max(5, Math.min(200, Math.floor(rows))),
        cwd,
        env: shellEnv()
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onData({ tabId: paneId, chunk: `buildflow: cannot start ${shell}: ${message}\r
` });
      return;
    }
    const session = { proc, cwd };
    this.sessions.set(paneId, session);
    const queued = this.pending.get(paneId);
    if (queued?.length) {
      this.pending.delete(paneId);
      setTimeout(() => {
        if (this.sessions.get(paneId) !== session) return;
        for (const data of queued) session.proc.write(data);
      }, 400);
    }
    proc.onData((chunk) => {
      OSC7.lastIndex = 0;
      let match;
      let last = null;
      while (match = OSC7.exec(chunk)) last = match[1];
      if (last) {
        const next = decodeURIComponent(last);
        if (next && next !== session.cwd) {
          session.cwd = next;
          this.onCwd({ paneId, cwd: next });
        }
      }
      this.onData({ tabId: paneId, chunk });
    });
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(paneId);
      this.onExit({ tabId: paneId, code: exitCode, cwd: session.cwd, durationMs: 0, sessionEnded: true });
    });
  }
  /** Keystrokes and pasted text, straight to the PTY. */
  write(paneId, data) {
    this.sessions.get(paneId)?.proc.write(data);
  }
  /**
   * Write on behalf of the app rather than the keyboard. A pane opened a
   * moment ago has no PTY yet, and `write` would drop the data on the floor —
   * so hold it until `open` runs.
   */
  send(paneId, data) {
    const session = this.sessions.get(paneId);
    if (session) {
      session.proc.write(data);
      return;
    }
    const queue = this.pending.get(paneId) ?? [];
    queue.push(data);
    this.pending.set(paneId, queue);
  }
  resize(paneId, cols, rows) {
    const session = this.sessions.get(paneId);
    if (!session) return;
    try {
      session.proc.resize(
        Math.max(20, Math.min(500, Math.floor(cols))),
        Math.max(5, Math.min(200, Math.floor(rows)))
      );
    } catch {
    }
  }
  dispose(paneId) {
    this.pending.delete(paneId);
    const session = this.sessions.get(paneId);
    if (!session) return;
    this.sessions.delete(paneId);
    try {
      session.proc.kill();
    } catch {
    }
  }
  disposeAll() {
    for (const paneId of [...this.sessions.keys()]) this.dispose(paneId);
  }
}
function parseWorktreeList(raw) {
  const entries = [];
  let dir = "";
  let branch = null;
  const flush = () => {
    if (dir) entries.push({ path: dir, branch });
    dir = "";
    branch = null;
  };
  for (const line of raw.split("\n")) {
    const t = line.replace(/\r$/, "").trimEnd();
    if (!t) {
      flush();
      continue;
    }
    if (t.startsWith("worktree ")) dir = t.slice("worktree ".length);
    else if (t.startsWith("branch ")) {
      const ref = t.slice("branch ".length);
      branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (t === "detached") {
      branch = null;
    }
  }
  flush();
  return entries;
}
function parseAlreadyOpenPath(message) {
  const m = /already (?:checked out|used by worktree) at (?:'([^']+)'|"([^"]+)"|(\S+))/i.exec(
    message
  );
  return (m?.[1] || m?.[2] || m?.[3] || "").trim() || null;
}
function folderSafe(s) {
  return s.trim().replace(/[\\/]+/g, "-").replace(/[<>:"|?*]/g, "").replace(/\.{2,}/g, "").replace(/^[-.\s]+|[-.\s]+$/g, "");
}
function worktreeFolderName(repoName, branch, custom) {
  return folderSafe(custom ?? "") || `${repoName}-${folderSafe(branch) || "branch"}`;
}
function git(cwd, args, timeout = 1e4) {
  return new Promise((resolve) => {
    child_process.execFile(
      "git",
      args,
      { cwd, timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, out: stdout.toString(), err: stderr.toString() });
      }
    );
  });
}
async function refExists(cwd, ref) {
  const res = await git(cwd, ["show-ref", "--verify", "--quiet", ref]);
  return res.code === 0;
}
async function info(cwd) {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.out.trim() !== "true") {
    return { isRepo: false, branch: "", branches: [] };
  }
  const [head2, list, remoteList, trees] = await Promise.all([
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(cwd, ["branch", "--format=%(refname:short)", "--sort=-committerdate"]),
    git(cwd, ["branch", "-r", "--format=%(refname:short)", "--sort=-committerdate"]),
    git(cwd, ["worktree", "list", "--porcelain"])
  ]);
  const worktrees = parseWorktreeList(trees.out).flatMap(
    (t) => t.branch ? [{ path: t.path, branch: t.branch }] : []
  );
  const branch = head2.out.trim();
  const branches = list.out.split("\n").map((b) => b.trim()).filter(Boolean);
  const local = new Set(branches);
  const remotes = remoteList.out.split("\n").map((b) => b.trim()).filter((b) => b.includes("/") && !b.endsWith("/HEAD") && !local.has(b.replace(/^[^/]+\//, "")));
  if (branch === "HEAD") {
    const sha = await git(cwd, ["rev-parse", "--short", "HEAD"]);
    return {
      isRepo: true,
      branch: sha.out.trim() || "detached",
      branches,
      remotes,
      detached: true,
      worktrees
    };
  }
  return {
    isRepo: true,
    branch,
    branches: branches.includes(branch) ? branches : [branch, ...branches],
    remotes,
    worktrees
  };
}
async function checkout(cwd, branch) {
  const res = await git(cwd, ["checkout", branch]);
  const message = (res.err || res.out).trim().split("\n")[0] || "";
  return { ok: res.code === 0, message };
}
async function resolveBase(cwd, base) {
  const b = base.trim();
  if (!b) return null;
  if (await refExists(cwd, `refs/heads/${b}`)) return { ref: b, remote: false };
  if (await refExists(cwd, `refs/remotes/${b}`)) return { ref: b, remote: true };
  if (await refExists(cwd, `refs/remotes/origin/${b}`)) return { ref: `origin/${b}`, remote: true };
  return null;
}
async function addWorktree(cwd, req) {
  const name = req.branch.trim();
  if (!name) return { ok: false, message: "Enter a branch name" };
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    return { ok: false, message: (top.err || top.out).trim() || "not a git repository" };
  }
  const toplevel = top.out.trim();
  const listed = await git(cwd, ["worktree", "list", "--porcelain"]);
  const trees = parseWorktreeList(listed.out);
  const existing = trees.find((t) => t.branch === name);
  if (existing && fs.existsSync(existing.path)) {
    return { ok: true, path: existing.path, branch: name, reused: true, message: "" };
  }
  const head2 = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head2.out.trim() === name) {
    return { ok: true, path: toplevel, branch: name, reused: true, message: "" };
  }
  const destBase = path.join(
    path.dirname(toplevel),
    worktreeFolderName(path.basename(toplevel), name, req.folder)
  );
  if (fs.existsSync(destBase)) {
    const at = await git(destBase, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (at.code === 0 && at.out.trim() === name) {
      return { ok: true, path: destBase, branch: name, reused: true, message: "" };
    }
    if (req.folder?.trim()) {
      return { ok: false, message: `${path.basename(destBase)} already exists` };
    }
  }
  let dest = destBase;
  for (let n = 2; fs.existsSync(dest); n++) dest = `${destBase}-${n}`;
  let args;
  if (await refExists(cwd, `refs/heads/${name}`)) {
    args = ["worktree", "add", dest, name];
  } else if (req.base?.trim()) {
    const from = await resolveBase(cwd, req.base);
    if (!from) return { ok: false, message: `unknown branch ${req.base.trim()}` };
    args = from.remote ? ["worktree", "add", "--track", "-b", name, dest, from.ref] : ["worktree", "add", "-b", name, dest, from.ref];
  } else if (await refExists(cwd, `refs/remotes/origin/${name}`)) {
    args = ["worktree", "add", "--track", "-b", name, dest, `origin/${name}`];
  } else {
    args = ["worktree", "add", "-b", name, dest];
  }
  const res = await git(cwd, args, 12e4);
  if (res.code !== 0) {
    const message = (res.err || res.out).trim().split("\n").filter(Boolean).pop() || "could not create worktree";
    const open = parseAlreadyOpenPath(message);
    if (open && fs.existsSync(open)) {
      return { ok: true, path: open, branch: name, reused: true, message: "" };
    }
    return { ok: false, message };
  }
  return { ok: true, path: dest, branch: name, message: "" };
}
class HeadWatcher {
  constructor(onChange) {
    this.onChange = onChange;
  }
  watcher = null;
  timer = null;
  cwd = "";
  async watch(cwd) {
    this.stop();
    this.cwd = cwd;
    const dir = await git(cwd, ["rev-parse", "--absolute-git-dir"]);
    const gitDir = dir.out.trim();
    if (dir.code !== 0 || !gitDir) return;
    const head2 = path.join(gitDir, "HEAD");
    try {
      this.watcher = fs.watch(head2, () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.onChange(this.cwd), 120);
      });
    } catch {
    }
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
const FAILURE_REPORT_REL = ".buildflow/last-failure.md";
function verifySection(r) {
  return [
    "## Verify your fix",
    "",
    `Re-run the whole pipeline, not just the failing command. Use the \`buildflow\` MCP tool \`run_pipeline\` with pipeline \`${r.pipeline}\`; call \`list_pipelines\` first if you need the exact id. The run shows up in the BuildFlow window while it executes.`,
    "",
    `If that tool is not available to you, run the command above directly in \`${r.branch}\`, then say so in your summary — a green command is weaker evidence than a green pipeline.`,
    ""
  ];
}
function failureReport(r) {
  return [
    "# Pipeline failure",
    "",
    `- Pipeline: ${r.pipeline}`,
    `- Step: ${r.step}`,
    `- Branch: ${r.branch}`,
    `- Exit code: ${r.code}`,
    "",
    "Command that failed:",
    "",
    "```sh",
    r.cmd,
    "```",
    "",
    "## Output",
    "",
    "```text",
    r.output.trim().slice(-12e3) || "(no output)",
    "```",
    "",
    ...verifySection(r)
  ].join("\n");
}
function gitignoreWithEntry(current, entry) {
  if (current.split("\n").some((line) => line.trim() === entry)) return null;
  if (!current) return `${entry}
`;
  return current.endsWith("\n") ? `${current}${entry}
` : `${current}
${entry}
`;
}
function isAiProvider(value) {
  return value === "claude" || value === "codex" || value === "cursor" || value === "opencode";
}
function normalizeAi(value) {
  return isAiProvider(value) ? value : "claude";
}
function aiCommand(provider, prompt) {
  switch (provider) {
    case "codex":
      return {
        bins: ["codex"],
        args: ["exec", prompt],
        hint: "Install the Codex CLI (npm i -g @openai/codex) to run Codex steps."
      };
    case "cursor":
      return {
        bins: ["agent", "cursor-agent"],
        args: ["-p", "--force", "--mode=ask", "--output-format", "text", prompt],
        hint: "Install the Cursor CLI (https://cursor.com/docs/cli) to run Cursor steps."
      };
    case "opencode":
      return {
        bins: ["opencode"],
        args: ["run", "--auto", prompt],
        hint: "Install the OpenCode CLI (https://opencode.ai) to run OpenCode steps."
      };
    case "claude":
      return {
        bins: ["claude"],
        args: ["-p", prompt],
        hint: "Install the Claude Code CLI (npm i -g @anthropic-ai/claude-code) to run Claude steps."
      };
  }
}
const ANSI_OSC = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s) {
  return s.replace(ANSI_OSC, "").replace(ANSI_CSI, "");
}
function plainText(raw) {
  return stripAnsi(raw).replace(/\r\n/g, "\n").split("\n").map((line) => {
    const last = line.lastIndexOf("\r");
    const visible = last >= 0 ? line.slice(last + 1) : line;
    return visible.replace(/[ \t]+$/, "");
  }).filter((line, i, all) => !(/^%\s*$/.test(line) && i < all.length - 1)).join("\n").replace(/^%\s*$/, "");
}
function defaultGate(type) {
  return type === "shell";
}
function nodeGate(n) {
  return n.gate ?? defaultGate(n.type);
}
function chainToNodes(steps) {
  return steps.map((s, i) => ({
    id: `n${i + 1}`,
    name: s.name,
    type: s.type,
    cmd: s.cmd,
    ...s.type === "ai" ? { ai: normalizeAi(s.ai) } : {},
    after: i === 0 ? [] : [`n${i}`],
    gate: defaultGate(s.type),
    x: 72,
    y: 48 + i * 112
  }));
}
function topoSort(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = /* @__PURE__ */ new Map();
  for (const n of nodes) indeg.set(n.id, 0);
  for (const n of nodes) {
    for (const p of n.after) {
      if (!byId.has(p)) continue;
      indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
    }
  }
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const out = [];
  while (queue.length) {
    const id = queue.shift();
    const n = byId.get(id);
    if (n) out.push(n);
    for (const c of nodes) {
      if (!c.after.includes(id)) continue;
      const d = (indeg.get(c.id) ?? 1) - 1;
      indeg.set(c.id, d);
      if (d === 0) queue.push(c.id);
    }
  }
  return out.length === nodes.length ? out : null;
}
function readyIds(nodes, done, skipped, started) {
  const finished = /* @__PURE__ */ new Set([...done, ...skipped]);
  return nodes.filter((n) => {
    if (started.has(n.id) || finished.has(n.id)) return false;
    return n.after.every((p) => !nodes.some((x) => x.id === p) || finished.has(p));
  }).map((n) => n.id);
}
function descendants(nodes, id) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const q = nodes.filter((n) => n.after.includes(id)).map((n) => n.id);
  while (q.length) {
    const cur = q.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const n of nodes) if (n.after.includes(cur)) q.push(n.id);
  }
  return out;
}
function ancestors(nodes, id) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = /* @__PURE__ */ new Set();
  const walk = (nid) => {
    const n = byId.get(nid);
    if (!n) return;
    for (const p of n.after) {
      if (seen.has(p) || !byId.has(p)) continue;
      seen.add(p);
      walk(p);
    }
  };
  walk(id);
  return [...seen];
}
function sanitizeNode$1(raw, fallbackId) {
  if (!raw || typeof raw !== "object") return null;
  const n = raw;
  const type = n.type === "ai" ? "ai" : "shell";
  const id = typeof n.id === "string" && n.id ? n.id : fallbackId;
  const after = Array.isArray(n.after) ? n.after.filter((x2) => typeof x2 === "string" && x2 !== id) : [];
  const x = typeof n.x === "number" && Number.isFinite(n.x) ? n.x : 72;
  const y = typeof n.y === "number" && Number.isFinite(n.y) ? n.y : 48;
  const gate = typeof n.gate === "boolean" ? n.gate : defaultGate(type);
  return {
    id,
    name: typeof n.name === "string" ? n.name : "",
    type,
    cmd: typeof n.cmd === "string" ? n.cmd : "",
    ...type === "ai" ? { ai: normalizeAi(n.ai) } : {},
    after,
    gate,
    x,
    y
  };
}
function sanitizeStep(raw) {
  if (!raw || typeof raw !== "object") return null;
  const s = raw;
  const type = s.type === "ai" ? "ai" : "shell";
  return {
    name: typeof s.name === "string" ? s.name : "",
    type,
    cmd: typeof s.cmd === "string" ? s.cmd : "",
    ...type === "ai" ? { ai: normalizeAi(s.ai) } : {}
  };
}
function sanitizePipeline(raw) {
  if (!raw || typeof raw !== "object") return null;
  const p = raw;
  if (typeof p.id !== "string" || typeof p.name !== "string") return null;
  let nodes = [];
  if (Array.isArray(p.nodes) && p.nodes.length) {
    nodes = p.nodes.flatMap((n, i) => {
      const node = sanitizeNode$1(n, `n${i + 1}`);
      return node ? [node] : [];
    });
  } else if (Array.isArray(p.steps) && p.steps.length) {
    const steps = p.steps.flatMap((s) => {
      const step = sanitizeStep(s);
      return step ? [step] : [];
    });
    nodes = chainToNodes(steps);
  }
  if (!nodes.length) return { id: p.id, name: p.name, nodes: [] };
  const ids = new Set(nodes.map((n) => n.id));
  nodes = nodes.map((n) => ({ ...n, after: n.after.filter((a) => ids.has(a)) }));
  if (!topoSort(nodes)) {
    nodes = nodes.map((n, i) => ({
      ...n,
      after: i === 0 ? [] : [nodes[i - 1].id]
    }));
  }
  return { id: p.id, name: p.name, nodes };
}
function sanitizePipelines(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((p) => {
    const pipe = sanitizePipeline(p);
    return pipe ? [pipe] : [];
  });
}
function resolvePipeline(pipelines, query) {
  const q = query.trim();
  if (!q) return { ok: false, message: "Name or id required", candidates: [] };
  const byId = pipelines.find((p) => p.id === q);
  if (byId) return { ok: true, pipeline: byId };
  const lower = q.toLowerCase();
  const byName = pipelines.filter((p) => p.name.toLowerCase() === lower);
  if (byName.length === 1) return { ok: true, pipeline: byName[0] };
  const partial = pipelines.filter(
    (p) => p.name.toLowerCase().includes(lower) || p.id.toLowerCase().includes(lower)
  );
  if (partial.length === 1) return { ok: true, pipeline: partial[0] };
  if (partial.length > 1) {
    return {
      ok: false,
      message: `"${q}" matches more than one pipeline`,
      candidates: partial.map((p) => `${p.name} (${p.id})`)
    };
  }
  return {
    ok: false,
    message: `No pipeline matches "${q}"`,
    candidates: pipelines.map((p) => `${p.name} (${p.id})`)
  };
}
function extraBinDirs() {
  const home = os.homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".cursor", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin")
  ];
}
function searchDirs() {
  const fromPath = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extra = extraBinDirs().filter((dir) => !fromPath.includes(dir));
  return [...extra, ...fromPath];
}
function resolveBin(name) {
  if (name.includes(path.sep)) return fs.existsSync(name) ? name : null;
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of searchDirs()) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
      }
    }
  }
  return null;
}
function aiEnv() {
  const env = shellEnv();
  const fromPath = (env.PATH || "").split(path.delimiter).filter(Boolean);
  const extra = extraBinDirs().filter((dir) => !fromPath.includes(dir));
  env.PATH = [...extra, ...fromPath].join(path.delimiter);
  return env;
}
function writeFailureReport(cwd, pipelineName, branch, node, output, code) {
  if (!node) return void 0;
  try {
    const file = path.join(cwd, FAILURE_REPORT_REL);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, ".gitignore");
    const current = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
    const next = gitignoreWithEntry(current, path.basename(file));
    if (next !== null) fs.writeFileSync(ignore, next, "utf8");
    fs.writeFileSync(
      file,
      failureReport({
        pipeline: pipelineName,
        step: node.name || node.id,
        branch,
        cmd: node.cmd,
        code,
        output
      }),
      "utf8"
    );
    return file;
  } catch {
    return void 0;
  }
}
class PipelineRunner {
  constructor(emit) {
    this.emit = emit;
  }
  active = /* @__PURE__ */ new Map();
  start(pipeline, cwd, branch, origin = "app") {
    const existing = this.active.get(pipeline.id);
    if (existing) return existing.runId;
    const runId = `${pipeline.id}:${Date.now()}`;
    const state = {
      runId,
      branch,
      origin,
      session: null,
      sessionBusy: false,
      currentShellId: null,
      aiProcs: /* @__PURE__ */ new Map(),
      oneshots: /* @__PURE__ */ new Map(),
      finishers: /* @__PURE__ */ new Map(),
      cancelled: false
    };
    this.active.set(pipeline.id, state);
    void this.execute(pipeline, cwd, state);
    return runId;
  }
  cancel(pipelineId) {
    const state = this.active.get(pipelineId);
    if (!state) return;
    state.cancelled = true;
    state.session?.interrupt();
    for (const proc of state.aiProcs.values()) killPty(proc);
    state.aiProcs.clear();
    for (const child of state.oneshots.values()) {
      if (child.pid) killPidTree(child.pid);
    }
    state.oneshots.clear();
    for (const done of state.finishers.values()) done(130);
    state.finishers.clear();
    state.session?.kill();
  }
  cancelAll() {
    for (const id of [...this.active.keys()]) this.cancel(id);
  }
  async execute(pipeline, cwd, state) {
    const { runId, branch, origin } = state;
    const pipelineId = pipeline.id;
    const nodes = topoSort(pipeline.nodes) ?? pipeline.nodes;
    const indexOf = new Map(nodes.map((n, i) => [n.id, i]));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    this.emit({ kind: "start", runId, pipelineId, branch, origin, steps: nodes.length });
    const outputs = {};
    const done = /* @__PURE__ */ new Set();
    const skipped = /* @__PURE__ */ new Set();
    const started = /* @__PURE__ */ new Set();
    const inflight = /* @__PURE__ */ new Map();
    let failedAt;
    let failedNodeId;
    let failedCode = 1;
    const emitOut = (nodeId, chunk) => {
      outputs[nodeId] = (outputs[nodeId] || "") + plainText(chunk);
      this.emit({
        kind: "output",
        runId,
        pipelineId,
        branch,
        origin,
        index: indexOf.get(nodeId) ?? 0,
        nodeId,
        chunk
      });
    };
    state.session = new PtySession({
      cwd,
      cols: 110,
      onData: (chunk) => {
        if (state.currentShellId) emitOut(state.currentShellId, chunk);
      },
      onEnd: () => {
        state.session = null;
      }
    });
    const shellReady = await state.session.whenReady();
    if (state.cancelled) {
      state.session?.kill();
      state.session = null;
    } else if (!shellReady) {
      emitOut(nodes[0]?.id ?? "n1", "buildflow: login shell did not become ready; shell steps run as one-shot commands.\r\n");
      state.session?.kill();
      state.session = null;
    }
    const skipCone = (fromId) => {
      for (const id of descendants(nodes, fromId)) {
        if (done.has(id) || skipped.has(id) || started.has(id)) continue;
        skipped.add(id);
        this.emit({
          kind: "step-end",
          runId,
          pipelineId,
          branch,
          origin,
          index: indexOf.get(id) ?? 0,
          nodeId: id,
          ok: false,
          code: 0,
          durationMs: 0,
          skipped: true
        });
      }
    };
    const runNode = async (node) => {
      const index = indexOf.get(node.id) ?? 0;
      this.emit({ kind: "step-start", runId, pipelineId, branch, origin, index, nodeId: node.id });
      const ancestorIds = new Set(ancestors(nodes, node.id));
      const context = nodes.filter((n) => ancestorIds.has(n.id)).map((n) => outputs[n.id] || "").join("").trim().slice(-12e3);
      const onChunk = (chunk) => emitOut(node.id, chunk);
      const startedAt = Date.now();
      const code = await this.runStep(node, cwd, context, state, onChunk);
      const durationMs = Date.now() - startedAt;
      const ok = code === 0 && !state.cancelled;
      this.emit({
        kind: "step-end",
        runId,
        pipelineId,
        branch,
        origin,
        index,
        nodeId: node.id,
        ok,
        code,
        durationMs,
        cancelled: state.cancelled || void 0
      });
      if (state.cancelled) {
        skipped.add(node.id);
        return;
      }
      done.add(node.id);
      if (!ok) {
        if (failedNodeId === void 0) {
          failedAt = index;
          failedNodeId = node.id;
          failedCode = code;
        }
        if (nodeGate(node)) skipCone(node.id);
      }
    };
    const pump = () => {
      if (state.cancelled) return;
      for (const id of readyIds(nodes, done, skipped, started)) {
        const node = byId.get(id);
        if (!node) continue;
        started.add(id);
        const p = runNode(node).finally(() => inflight.delete(id));
        inflight.set(id, p);
      }
    };
    pump();
    while (inflight.size) {
      await Promise.race([...inflight.values()]);
      if (state.cancelled) {
        for (const n of nodes) {
          if (!done.has(n.id) && !skipped.has(n.id) && !started.has(n.id)) {
            skipped.add(n.id);
            this.emit({
              kind: "step-end",
              runId,
              pipelineId,
              branch,
              origin,
              index: indexOf.get(n.id) ?? 0,
              nodeId: n.id,
              ok: false,
              code: 130,
              durationMs: 0,
              cancelled: true
            });
          }
        }
        break;
      }
      pump();
    }
    state.session?.kill();
    state.session = null;
    this.active.delete(pipelineId);
    const reportPath = failedNodeId !== void 0 && !state.cancelled ? writeFailureReport(
      cwd,
      pipeline.name,
      branch,
      byId.get(failedNodeId),
      outputs[failedNodeId] || "",
      failedCode
    ) : void 0;
    this.emit({
      kind: "end",
      runId,
      pipelineId,
      branch,
      origin,
      ok: failedAt === void 0 && !state.cancelled,
      failedAt,
      failedNodeId,
      cancelled: state.cancelled || void 0,
      reportPath
    });
  }
  async runStep(node, cwd, context, state, onChunk) {
    if (node.type === "shell") {
      if (state.cancelled) return 130;
      const takeSession = !!state.session && !state.sessionBusy;
      if (takeSession && state.session) {
        state.sessionBusy = true;
        state.currentShellId = node.id;
        try {
          const { code } = await state.session.exec(node.cmd);
          return code;
        } finally {
          if (state.currentShellId === node.id) state.currentShellId = null;
          state.sessionBusy = false;
        }
      }
      return this.runOneshot(node.id, node.cmd, cwd, state, onChunk);
    }
    const prompt = context ? `${node.cmd}

--- Pipeline output so far ---
${context}` : node.cmd;
    const spec = aiCommand(normalizeAi(node.ai), prompt);
    let bin = null;
    for (const name of spec.bins) {
      bin = resolveBin(name);
      if (bin) break;
    }
    if (!bin) {
      const listed = spec.bins.map((b) => `'${b}'`).join(" or ");
      onChunk(`buildflow: ${listed} is not on PATH. ${spec.hint}\r
`);
      return 127;
    }
    return new Promise((resolve) => {
      const done = (code) => {
        if (state.finishers.get(node.id) !== done) return;
        state.finishers.delete(node.id);
        const proc2 = state.aiProcs.get(node.id);
        if (proc2) {
          state.aiProcs.delete(node.id);
        }
        resolve(code);
      };
      state.finishers.set(node.id, done);
      if (state.cancelled) {
        done(130);
        return;
      }
      let proc;
      try {
        proc = pty__namespace.spawn(bin, spec.args, {
          name: "xterm-256color",
          cols: 110,
          rows: 40,
          cwd,
          env: aiEnv()
        });
      } catch (err) {
        onChunk(`buildflow: ${err instanceof Error ? err.message : String(err)}\r
`);
        done(127);
        return;
      }
      state.aiProcs.set(node.id, proc);
      proc.onData(onChunk);
      proc.onExit(({ exitCode, signal }) => {
        done(signal && exitCode === 0 ? 130 : exitCode);
      });
      if (state.cancelled) {
        killPty(proc);
        done(130);
      }
    });
  }
  runOneshot(nodeId, cmd, cwd, state, onChunk) {
    return new Promise((resolve) => {
      const shell = defaultShell();
      const family = shellFamily(shell);
      const args = family === "powershell" ? ["-NoLogo", "-Command", cmd] : ["-lc", cmd];
      let child;
      try {
        child = child_process.spawn(shell, args, { cwd, env: pipelineEnv(), windowsHide: true });
      } catch (err) {
        onChunk(`buildflow: ${err instanceof Error ? err.message : String(err)}\r
`);
        resolve(127);
        return;
      }
      state.oneshots.set(nodeId, child);
      const push = (buf) => {
        onChunk(buf.toString().replace(/\r?\n/g, "\r\n"));
      };
      child.stdout?.on("data", push);
      child.stderr?.on("data", push);
      child.on("error", (err) => {
        if (state.oneshots.get(nodeId) === child) state.oneshots.delete(nodeId);
        onChunk(`buildflow: ${err.message}\r
`);
        resolve(127);
      });
      child.on("close", (code, signal) => {
        if (state.oneshots.get(nodeId) === child) state.oneshots.delete(nodeId);
        resolve(state.cancelled ? 130 : signal ? 130 : code ?? 127);
      });
    });
  }
}
function savedLeaves(n, out = []) {
  if (n.t === "leaf") out.push(n.id);
  else {
    savedLeaves(n.a, out);
    savedLeaves(n.b, out);
  }
  return out;
}
function sanitizeNode(raw) {
  if (!raw || typeof raw !== "object") return null;
  const n = raw;
  if (n.t === "leaf" && typeof n.id === "string" && n.id) return { t: "leaf", id: n.id };
  if (n.t === "split" && (n.dir === "row" || n.dir === "col") && typeof n.id === "string") {
    const a = sanitizeNode(n.a);
    const b = sanitizeNode(n.b);
    if (!a || !b) return null;
    const size = typeof n.size === "number" && Number.isFinite(n.size) ? n.size : 50;
    return { t: "split", id: n.id, dir: n.dir, size: Math.min(85, Math.max(15, size)), a, b };
  }
  return null;
}
function sanitizeSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  const s = raw;
  if (!Array.isArray(s.tabs)) return null;
  const tabs = [];
  for (const t of s.tabs) {
    if (!t || typeof t !== "object") continue;
    const tab = t;
    const root = sanitizeNode(tab.root);
    if (typeof tab.id !== "string" || !root) continue;
    const leafIds = savedLeaves(root);
    const paneList = Array.isArray(tab.panes) ? tab.panes : [];
    const panes = [];
    const byId = /* @__PURE__ */ new Map();
    for (const p of paneList) {
      if (!p || typeof p !== "object") continue;
      const pane = p;
      if (typeof pane.id !== "string" || typeof pane.cwd !== "string") continue;
      const sp = {
        id: pane.id,
        title: typeof pane.title === "string" ? pane.title : "",
        cwd: pane.cwd
      };
      byId.set(sp.id, sp);
    }
    for (const id of leafIds) {
      const pane = byId.get(id);
      if (!pane) continue;
      panes.push(pane);
    }
    if (panes.length !== leafIds.length) continue;
    const focus = typeof tab.focus === "string" && leafIds.includes(tab.focus) ? tab.focus : leafIds[0];
    tabs.push({
      id: tab.id,
      title: typeof tab.title === "string" ? tab.title : "",
      ...typeof tab.branch === "string" && tab.branch ? { branch: tab.branch } : {},
      root,
      focus,
      panes
    });
  }
  if (!tabs.length) return null;
  const ids = new Set(tabs.map((t) => t.id));
  const activeTab = typeof s.activeTab === "string" && ids.has(s.activeTab) ? s.activeTab : tabs[0].id;
  const sidebarW = typeof s.sidebarW === "number" && Number.isFinite(s.sidebarW) ? Math.min(400, Math.max(240, s.sidebarW)) : 300;
  return {
    sidebarW,
    selId: typeof s.selId === "string" ? s.selId : null,
    activeTab,
    tabs
  };
}
function defaultSettings() {
  return { agent: "claude", autoFix: true };
}
function sanitizeSettings(raw) {
  const d = defaultSettings();
  if (!raw || typeof raw !== "object") return d;
  const s = raw;
  return {
    agent: isAiProvider(s.agent) ? s.agent : d.agent,
    autoFix: typeof s.autoFix === "boolean" ? s.autoFix : d.autoFix
  };
}
function toProject(dir) {
  const abs = path.resolve(dir);
  const home = os.homedir();
  return {
    name: path.basename(abs) || abs,
    path: abs,
    display: abs === home ? "~" : abs.startsWith(home + path.sep) ? "~" + abs.slice(home.length) : abs
  };
}
const CONFIG_DIR = ".buildflow";
const CONFIG_FILE = "pipelines.json";
function defaultPipelines() {
  return [
    {
      id: "code-review",
      name: "Code Review",
      nodes: [
        {
          id: "n1",
          name: "Collect diff",
          type: "shell",
          cmd: "git diff main...HEAD --stat",
          after: [],
          gate: true,
          x: 186,
          y: 48
        },
        {
          id: "n2",
          name: "Claude review",
          type: "ai",
          ai: "claude",
          cmd: "Review the diff for bugs, risks, and style",
          after: ["n1"],
          gate: false,
          x: 72,
          y: 160
        },
        {
          id: "n3",
          name: "Cursor review",
          type: "ai",
          ai: "cursor",
          cmd: "Review the same diff independently; flag anything Claude might miss",
          after: ["n1"],
          gate: false,
          x: 300,
          y: 160
        },
        {
          id: "n4",
          name: "Summarize",
          type: "ai",
          ai: "claude",
          cmd: "Combine both reviews into a one-paragraph summary on the run log",
          after: ["n2", "n3"],
          gate: false,
          x: 186,
          y: 272
        }
      ]
    },
    {
      id: "lint",
      name: "Lint & Typecheck",
      nodes: [
        {
          id: "n1",
          name: "ESLint",
          type: "shell",
          cmd: "npx eslint . --max-warnings 0",
          after: [],
          gate: true,
          x: 72,
          y: 48
        },
        {
          id: "n2",
          name: "TypeScript",
          type: "shell",
          cmd: "npx tsc --noEmit",
          after: [],
          gate: true,
          x: 300,
          y: 48
        }
      ]
    },
    {
      id: "full",
      name: "Full Check",
      nodes: [
        {
          id: "n1",
          name: "ESLint",
          type: "shell",
          cmd: "npx eslint . --max-warnings 0",
          after: [],
          gate: true,
          x: 72,
          y: 48
        },
        {
          id: "n2",
          name: "TypeScript",
          type: "shell",
          cmd: "npx tsc --noEmit",
          after: [],
          gate: true,
          x: 300,
          y: 48
        },
        {
          id: "n3",
          name: "AI Review",
          type: "ai",
          ai: "claude",
          cmd: "Review lint/type output and the diff; flag risks",
          after: ["n1", "n2"],
          gate: false,
          x: 186,
          y: 160
        },
        {
          id: "n4",
          name: "Summarize",
          type: "ai",
          ai: "claude",
          cmd: "Post a one-paragraph summary to the run log",
          after: ["n3"],
          gate: false,
          x: 186,
          y: 272
        }
      ]
    },
    {
      id: "ship",
      name: "Ship to GitHub",
      nodes: [
        {
          id: "n1",
          name: "Run tests",
          type: "shell",
          cmd: "npm test",
          after: [],
          gate: true,
          x: 72,
          y: 48
        },
        {
          id: "n2",
          name: "Build",
          type: "shell",
          cmd: "npm run build",
          after: ["n1"],
          gate: true,
          x: 72,
          y: 160
        },
        {
          id: "n3",
          name: "Push & open PR",
          type: "shell",
          cmd: "git push && gh pr create --fill",
          after: ["n2"],
          gate: true,
          x: 72,
          y: 272
        }
      ]
    }
  ];
}
function sanitize(raw) {
  return sanitizePipelines(raw);
}
async function loadPipelines(projectPath) {
  const file = path.join(projectPath, CONFIG_DIR, CONFIG_FILE);
  try {
    const parsed = sanitize(JSON.parse(await fs$1.readFile(file, "utf8")));
    if (parsed && parsed.length) return parsed;
    if (parsed) return [];
  } catch {
  }
  const seeded = defaultPipelines();
  await savePipelines(projectPath, seeded).catch(() => {
  });
  return seeded;
}
async function savePipelines(projectPath, pipelines) {
  const dir = path.join(projectPath, CONFIG_DIR);
  await fs$1.mkdir(dir, { recursive: true });
  const clean = sanitize(pipelines) ?? [];
  await fs$1.writeFile(path.join(dir, CONFIG_FILE), JSON.stringify(clean, null, 2) + "\n", "utf8");
}
function recentsFile() {
  return path.join(electron.app.getPath("userData"), "recent-projects.json");
}
async function readRecents() {
  try {
    const raw = JSON.parse(await fs$1.readFile(recentsFile(), "utf8"));
    if (!Array.isArray(raw)) return [];
    const paths = raw.filter((p) => !!p && typeof p.path === "string").map((p) => p.path);
    const alive = await Promise.all(
      paths.map(async (p) => (await fs$1.stat(p).catch(() => null))?.isDirectory() ? p : null)
    );
    return alive.filter((p) => p !== null).map(toProject).slice(0, 6);
  } catch {
    return [];
  }
}
async function pushRecent(project) {
  const prev = await readRecents();
  const next = [project, ...prev.filter((p) => p.path !== project.path)].slice(0, 6);
  await fs$1.mkdir(path.dirname(recentsFile()), { recursive: true });
  await fs$1.writeFile(recentsFile(), JSON.stringify(next, null, 2), "utf8").catch(() => {
  });
}
function workspaceFile() {
  return path.join(electron.app.getPath("userData"), "workspace.json");
}
async function readWorkspace() {
  try {
    const raw = JSON.parse(await fs$1.readFile(workspaceFile(), "utf8"));
    const lastProject = typeof raw.lastProject === "string" ? raw.lastProject : null;
    const sessions = {};
    if (raw.sessions && typeof raw.sessions === "object") {
      for (const [k, v] of Object.entries(raw.sessions)) {
        const s = sanitizeSession(v);
        if (s) sessions[k] = s;
      }
    }
    return { lastProject, sessions, settings: sanitizeSettings(raw.settings) };
  } catch {
    return { lastProject: null, sessions: {}, settings: sanitizeSettings(void 0) };
  }
}
async function writeWorkspace(ws) {
  await fs$1.mkdir(path.dirname(workspaceFile()), { recursive: true });
  await fs$1.writeFile(workspaceFile(), JSON.stringify(ws, null, 2) + "\n", "utf8").catch(() => {
  });
}
async function isDir(p) {
  return (await fs$1.stat(p).catch(() => null))?.isDirectory() ?? false;
}
async function lastProjectPath() {
  const ws = await readWorkspace();
  if (!ws.lastProject || !await isDir(ws.lastProject)) return null;
  return ws.lastProject;
}
async function loadProjectSession(projectPath, fallbackCwd) {
  const ws = await readWorkspace();
  const s = ws.sessions[projectPath];
  if (!s) return null;
  const tabs = [];
  for (const t of s.tabs) {
    const panes = await Promise.all(
      t.panes.map(async (p) => ({
        ...p,
        cwd: await isDir(p.cwd) ? p.cwd : fallbackCwd
      }))
    );
    tabs.push({ ...t, panes });
  }
  return { ...s, tabs };
}
async function saveProjectSession(projectPath, session, last) {
  const ws = await readWorkspace();
  const clean = sanitizeSession(session);
  if (clean) ws.sessions[projectPath] = clean;
  ws.lastProject = last ? projectPath : ws.lastProject === projectPath ? null : ws.lastProject;
  await writeWorkspace(ws);
}
async function loadSettings() {
  return sanitizeSettings((await readWorkspace()).settings);
}
async function saveSettings(settings) {
  const ws = await readWorkspace();
  ws.settings = sanitizeSettings(settings);
  await writeWorkspace(ws);
}
async function clearLastProject() {
  const ws = await readWorkspace();
  ws.lastProject = null;
  await writeWorkspace(ws);
}
function parseUpdateFeed(yml) {
  const version = /^version:\s*['"]?(.+?)['"]?\s*$/m.exec(yml)?.[1]?.trim();
  const file = /^path:\s*['"]?(.+?)['"]?\s*$/m.exec(yml)?.[1]?.trim();
  if (!version || !file) return null;
  return { version, file };
}
function parts(v) {
  return v.split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
}
function versionAhead(next, current) {
  const a = parts(next);
  const b = parts(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
function feedDir() {
  return path.join(os.homedir(), ".buildflow", "updates");
}
function sh(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function appBundle() {
  return path.resolve(process.execPath, "..", "..", "..");
}
class AppUpdater {
  constructor(emit) {
    this.emit = emit;
  }
  status = { state: "idle" };
  ready = null;
  set(status) {
    this.status = status;
    this.emit(status);
  }
  async check(opts) {
    const ymlPath = path.join(feedDir(), "latest-mac.yml");
    if (!fs.existsSync(ymlPath)) {
      this.ready = null;
      this.set({ state: "idle" });
      if (opts?.informNone) {
        await electron.dialog.showMessageBox({
          type: "info",
          message: "No update available",
          detail: "Build a new version with npm run dist. It will show up here."
        });
      }
      return this.status;
    }
    const feed = parseUpdateFeed(fs.readFileSync(ymlPath, "utf8"));
    if (!feed) {
      this.set({ state: "error", message: "Update feed is unreadable" });
      return this.status;
    }
    const zip = path.join(feedDir(), feed.file);
    if (!versionAhead(feed.version, electron.app.getVersion())) {
      this.ready = null;
      this.set({ state: "idle" });
      if (opts?.informNone) {
        await electron.dialog.showMessageBox({
          type: "info",
          message: "You’re up to date",
          detail: `BuildFlow ${electron.app.getVersion()} is the latest build.`
        });
      }
      return this.status;
    }
    if (!fs.existsSync(zip)) {
      this.set({ state: "error", message: `Update zip missing (${feed.file})` });
      if (opts?.informNone) {
        await electron.dialog.showMessageBox({ type: "warning", message: this.status.state === "error" ? this.status.message : "Update failed" });
      }
      return this.status;
    }
    this.ready = { version: feed.version, zip };
    this.set({ state: "ready", version: feed.version });
    if (opts?.informNone) {
      const { response } = await electron.dialog.showMessageBox({
        type: "info",
        message: `BuildFlow ${feed.version} is ready`,
        detail: "Restart to replace the running app.",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1
      });
      if (response === 0) this.install();
    }
    return this.status;
  }
  install() {
    if (!this.ready) return;
    if (process.platform !== "darwin") {
      this.set({ state: "error", message: "In-place updates are only wired for macOS" });
      return;
    }
    const pack = this.ready;
    const dest = appBundle();
    const tmp = path.join(os.tmpdir(), `buildflow-update-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const script = path.join(os.tmpdir(), `buildflow-apply-update-${Date.now()}.sh`);
    fs.writeFileSync(
      script,
      `#!/bin/bash
set -e
SRC_ZIP=${sh(pack.zip)}
TMP=${sh(tmp)}
DEST=${sh(dest)}
/usr/bin/ditto -xk "$SRC_ZIP" "$TMP"
NEW=$(/usr/bin/find "$TMP" -name '*.app' -maxdepth 3 | /usr/bin/head -n 1)
if [ -z "$NEW" ]; then
  echo "buildflow: unzipped update has no .app" >&2
  exit 1
fi
for i in 1 2 3 4 5 6 7 8 9 10; do
  if ! /usr/bin/pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1; then break; fi
  sleep 0.3
done
rm -rf "$DEST"
/usr/bin/ditto "$NEW" "$DEST"
xattr -cr "$DEST" >/dev/null 2>&1 || true
rm -rf "$TMP"
open -a "$DEST"
rm -f "$0"
`,
      { mode: 493 }
    );
    child_process.spawn(script, [], { detached: true, stdio: "ignore" }).unref();
    electron.app.quit();
  }
}
const MCP_SERVER_KEY = "buildflow";
function mergeMcpConfig(existing, entry) {
  let root = {};
  if (existing.trim()) {
    try {
      const parsed = JSON.parse(existing);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      root = parsed;
    } catch {
      return null;
    }
  }
  const servers = root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers) ? root.mcpServers : {};
  const current = servers[MCP_SERVER_KEY];
  if (current && JSON.stringify(current) === JSON.stringify(entry)) return null;
  const next = {
    ...root,
    mcpServers: { ...servers, [MCP_SERVER_KEY]: entry }
  };
  return JSON.stringify(next, null, 2) + "\n";
}
let win = null;
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
const shells = new ShellManager(
  (e) => send("shell:data", e),
  (e) => send("shell:exit", e),
  (e) => send("shell:cwd", e)
);
const runner = new PipelineRunner((e) => {
  send("run:event", e);
  for (const run of agentRuns) run.onEvent(e);
});
const head = new HeadWatcher(async (cwd) => send("git:changed", await info(cwd)));
const updater = new AppUpdater((s) => send("update:status", s));
function createWindow() {
  win = new electron.BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 520,
    show: false,
    frame: false,
    backgroundColor: "#1c1c1e",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.on("ready-to-show", () => win?.show());
  win.on("closed", () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void electron.shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
function buildMenu() {
  const isMac = process.platform === "darwin";
  electron.Menu.setApplicationMenu(
    electron.Menu.buildFromTemplate([
      ...isMac ? [
        {
          label: electron.app.name,
          submenu: [
            { role: "about" },
            {
              label: "Check for Updates…",
              click: () => void updater.check({ informNone: true })
            },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" }
          ]
        }
      ] : [],
      {
        label: "File",
        submenu: [
          {
            label: "Open Project…",
            accelerator: "CmdOrCtrl+O",
            click: async () => {
              const p = await openProjectDialog();
              if (p) send("project:opened", p);
            }
          },
          { type: "separator" },
          // Not `role: 'close'` — that would claim ⌘W, which closes a tab here.
          isMac ? { label: "Close Window", accelerator: "Shift+CmdOrCtrl+W", click: () => win?.close() } : { role: "quit" }
        ]
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" }
        ]
      }
    ])
  );
}
async function openProjectDialog() {
  if (!win) return null;
  const res = await electron.dialog.showOpenDialog(win, {
    title: "Open Project",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Open"
  });
  if (res.canceled || !res.filePaths.length) return null;
  const project = toProject(res.filePaths[0]);
  await pushRecent(project);
  installMcpConfig(project.path);
  startBridge(project.path);
  return project;
}
const agentRuns = /* @__PURE__ */ new Set();
const AGENT_RUN_TIMEOUT_MS = 15 * 60 * 1e3;
function runForAgent(pipeline, cwd, branch) {
  return new Promise((resolve) => {
    const nodes = topoSort(pipeline.nodes) ?? pipeline.nodes;
    const output = /* @__PURE__ */ new Map();
    const status = /* @__PURE__ */ new Map();
    let settled = false;
    const finish = (text, failed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      agentRuns.delete(run);
      resolve({ text, failed });
    };
    const run = {
      onEvent: (e) => {
        if (e.pipelineId !== pipeline.id || e.origin !== "agent") return;
        if (e.kind === "output") {
          output.set(e.nodeId, (output.get(e.nodeId) ?? "") + plainText(e.chunk));
        } else if (e.kind === "step-end") {
          status.set(e.nodeId, { label: e.skipped ? "SKIP" : e.ok ? "PASS" : "FAIL", code: e.code });
        } else if (e.kind === "end") {
          const lines = [
            `${e.cancelled ? "CANCELLED" : e.ok ? "PASSED" : "FAILED"}: ${pipeline.name} on ${branch}`,
            ""
          ];
          for (const n of nodes) {
            const st = status.get(n.id) ?? { label: "SKIP", code: 0 };
            lines.push(`[${st.label}] ${n.name || n.id}${st.label === "FAIL" ? ` (exit ${st.code})` : ""}`);
          }
          for (const n of nodes) {
            if (status.get(n.id)?.label !== "FAIL") continue;
            const text = (output.get(n.id) ?? "").trim().slice(-4e3);
            if (text) lines.push("", `--- output: ${n.name || n.id} ---`, text);
          }
          finish(lines.join("\n"), !e.ok);
        }
      }
    };
    agentRuns.add(run);
    const timer = setTimeout(() => {
      runner.cancel(pipeline.id);
      finish(`TIMED OUT after 15 minutes: ${pipeline.name}`, true);
    }, AGENT_RUN_TIMEOUT_MS);
    runner.start(pipeline, cwd, branch, "agent");
  });
}
async function handleBridge(req) {
  const pipelines = await loadPipelines(req.cwd);
  if (req.op === "list") {
    return {
      id: req.id,
      ok: true,
      op: "list",
      pipelines: pipelines.map((p) => ({
        id: p.id,
        name: p.name,
        steps: (topoSort(p.nodes) ?? p.nodes).map((n) => `${n.name || n.id} (${n.type})`)
      }))
    };
  }
  const found = resolvePipeline(pipelines, req.pipeline);
  if (!found.ok) {
    const detail = found.candidates.length ? `
Available:
- ${found.candidates.join("\n- ")}` : "";
    return { id: req.id, ok: false, message: found.message + detail };
  }
  const git2 = await info(req.cwd);
  const { text, failed } = await runForAgent(found.pipeline, req.cwd, git2.branch || "(no branch)");
  return { id: req.id, ok: true, op: "run", text, failed };
}
let bridge = null;
function startBridge(projectPath) {
  const file = socketPath(projectPath);
  bridge?.close();
  bridge = null;
  try {
    fs.rmSync(file, { force: true });
  } catch {
  }
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const { lines, rest } = bridge$1.takeLines(buffer);
      buffer = rest;
      for (const line of lines) {
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        void handleBridge(req).then((reply) => socket.write(JSON.stringify(reply) + "\n")).catch(
          (err) => socket.write(
            JSON.stringify({
              id: req.id,
              ok: false,
              message: err instanceof Error ? err.message : String(err)
            }) + "\n"
          )
        );
      }
    });
    socket.on("error", () => socket.destroy());
  });
  server.on("error", () => void 0);
  server.listen(file);
  bridge = server;
}
function socketPath(projectPath) {
  return bridge$1.socketPathFor(projectPath, os.tmpdir(), path.sep);
}
function mcpEntry(projectPath) {
  return {
    command: process.execPath,
    args: [path.join(electron.app.getAppPath(), "out", "main", "mcp.js")],
    env: { ELECTRON_RUN_AS_NODE: "1", [bridge$1.BRIDGE_ENV]: socketPath(projectPath) }
  };
}
function installMcpConfig(dir, socketFor = dir) {
  try {
    const file = path.join(dir, ".mcp.json");
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const next = mergeMcpConfig(existing, mcpEntry(socketFor));
    if (next !== null) fs.writeFileSync(file, next, "utf8");
  } catch {
  }
}
function registerIpc() {
  electron.ipcMain.handle("project:open", () => openProjectDialog());
  electron.ipcMain.handle("project:openPath", async (_e, dir) => {
    if (typeof dir !== "string" || !fs.existsSync(dir)) return null;
    const project = toProject(dir);
    await pushRecent(project);
    installMcpConfig(project.path);
    startBridge(project.path);
    startBridge(project.path);
    return project;
  });
  electron.ipcMain.handle("project:recents", () => readRecents());
  electron.ipcMain.handle("session:last", () => lastProjectPath());
  electron.ipcMain.handle(
    "session:load",
    (_e, projectPath) => loadProjectSession(projectPath, projectPath)
  );
  electron.ipcMain.handle("session:save", (_e, projectPath, session, last) => {
    if (typeof projectPath !== "string") return;
    return saveProjectSession(
      projectPath,
      session,
      !!last
    );
  });
  electron.ipcMain.handle("session:clearLast", () => clearLastProject());
  electron.ipcMain.handle("pipelines:load", (_e, projectPath) => loadPipelines(projectPath));
  electron.ipcMain.handle(
    "pipelines:save",
    (_e, projectPath, pipelines) => savePipelines(projectPath, pipelines)
  );
  electron.ipcMain.handle(
    "shell:open",
    (_e, paneId, cwd, cols, rows) => shells.open(paneId, cwd, cols, rows)
  );
  electron.ipcMain.handle("shell:write", (_e, paneId, data) => shells.write(paneId, data));
  electron.ipcMain.handle(
    "shell:resize",
    (_e, paneId, cols, rows) => shells.resize(paneId, cols, rows)
  );
  electron.ipcMain.handle("shell:dispose", (_e, paneId) => shells.dispose(paneId));
  electron.ipcMain.handle("shell:send", (_e, paneId, data) => shells.send(paneId, data));
  electron.ipcMain.handle("git:info", async (_e, projectPath) => {
    void head.watch(projectPath);
    return info(projectPath);
  });
  electron.ipcMain.handle(
    "git:checkout",
    (_e, projectPath, branch) => checkout(projectPath, branch)
  );
  electron.ipcMain.handle("git:worktree", async (_e, projectPath, req) => {
    const res = await addWorktree(projectPath, req);
    if (res.ok && res.path && res.path !== projectPath) installMcpConfig(res.path, projectPath);
    return res;
  });
  electron.ipcMain.handle(
    "run:start",
    (_e, pipeline, cwd, branch) => runner.start(pipeline, cwd, branch)
  );
  electron.ipcMain.handle("run:cancel", (_e, pipelineId) => runner.cancel(pipelineId));
  electron.ipcMain.handle("settings:load", () => loadSettings());
  electron.ipcMain.handle("settings:save", (_e, settings) => saveSettings(settings));
  electron.ipcMain.handle("update:check", () => updater.check());
  electron.ipcMain.on("update:install", () => updater.install());
  electron.ipcMain.on("window:minimize", () => win?.minimize());
  electron.ipcMain.on("window:maximize", () => win?.isMaximized() ? win.unmaximize() : win?.maximize());
  electron.ipcMain.on("window:close", () => win?.close());
}
electron.app.whenReady().then(() => {
  registerIpc();
  buildMenu();
  createWindow();
  if (electron.app.isPackaged) setTimeout(() => void updater.check(), 2500);
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
electron.app.on("before-quit", () => {
  shells.disposeAll();
  runner.cancelAll();
  head.stop();
});
