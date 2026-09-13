# Farol

A desktop app for running AI-assisted work in a local Git checkout, with Chat, pipelines, and Git actions on the same project.

## Language

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
The Compare, Base, **Merge status**, **Check conflicts**, title, and Create pull request block on the **Source Control page**. Compare is the current branch, Base is the known merge or PR base, and the title is unused. Create pull request stays hold-to-confirm and runs `gh pr create --fill`. Working-tree conflict paths and predicted GitHub conflict paths stay as lists on this block; **Merge status** text stays.
_Avoid_: Compare as a checkout picker, Base as a writable GitHub parameter, using the title for create, new `gh` flags, moving conflict paths off this block, hiding those paths

**Check conflicts**:
The always-visible **Pull request** action that is today's Resolve with AI: two-click confirm, same block reasons, then merge the PR or base and send files to Chat.
_Avoid_: hiding the button until a conflict signal, one-click resolve, a new merge or conflict path

**Merge status**:
The **Pull request** line that reports GitHub or base-merge conflict state. Until that has loaded, it reads Merge status unknown.
_Avoid_: hiding merge status when the tree is clean, a second status source

**Git log**:
The activity transcript on the **Source Control page**. Each line is a timed outcome of commit, push, create pull request, **Check conflicts**, a **Generate with AI** failure, or a status refresh failure. It replaces the single success and error banners. A successful generate is not a line — the **Commit message** box is the success. Refresh failures use one line per streak: append when a refresh fails after a success or on the first fail; stay quiet while it keeps failing; do not log successful polls. It lives on the **Git panel** for the session: it survives closing the **Source Control page**, resets when the project switches, and is not saved to disk. It is not a fetch log and does not add a fetch action.
_Avoid_: a single success/error banner as the only history, fetch lines, treating this as **Latest commits**, persisting the transcript to disk, keeping lastMessage/error as a second history, a line for every failed poll, logging successful refreshes, logging a successful generate, a silent generate failure

## Relationships

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
- **Pull request** Compare, Base, and title are layout only; create still hold-to-confirms `--fill` and does not check out a branch
- **Check conflicts** is always on the **Pull request** block and is the same **Git panel** resolve action
- **Merge status** is Merge status unknown until GitHub or base-merge status has loaded
- Working-tree and predicted conflict paths stay listed on the **Pull request** block; they are not **Changes** rows
- **Git log** appends timed outcomes for commit, push, create pull request, **Check conflicts**, **Generate with AI** failures, and refresh failures; it does not add fetch
- A successful **Generate with AI** is not a **Git log** line; the **Commit message** box is the success
- A refresh-failure **Git log** line is one per streak: append on the first fail or after a success, stay quiet while failures continue, and do not log successful polls
- **Git log** lives on the **Git panel** for the session: it survives close, resets on project switch, and is not saved to disk

## Example dialogue

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
> **Domain expert:** "Layout only. Compare is this branch, Base is the known merge/PR base, title is unused. Keep hold-to-confirm and `--fill`."
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

## Flagged ambiguities

- "Source Control page" is the overlay chrome (full-page, Escape to close), not a new app route — resolved with the replace-popover decision.
- The screenshot’s right-hand pipeline stepper is existing workspace chrome, not a **Source Control page** widget — resolved with Screenshot VC only.
- File checkboxes / Stage all appear on **Changes**, but the current **Git panel** has no stage action and commits all committable files — resolved: **Commit selection**, not `git add`. The current `commitAll` path still stages every committable file and treats `files` as a staleness check only; that must change so a commit includes only the selected paths.
- **Generate with AI** currently drafts from every committable file — resolved: it sees the **Commit selection** only.
- Today Commit is disabled until a draft exists — resolved: **Typed commit**. Generate is optional.
- Screenshot Compare / Base look like pickers, and a title field looks like a create input — resolved: layout only. Compare as a picker would check out a branch, which this app does in New Tab / worktree, not in Git. Create stays `--fill`.
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
