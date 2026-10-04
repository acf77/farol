# Product

## Register

product

## Users

Developers who live in a terminal and run the same sequences over and over: build, typecheck, test, lint, deploy, then hand something to an agent. They are on macOS, usually with one project folder open, often mid-task with a long-running process in another pane.

Their context is a working session, not a browsing session. They arrive already knowing what they want to run. The job to be done is: keep several real shells and several named, repeatable pipelines within reach of the same window, without losing the terminal they already trust.

The primary task on any given screen is either typing into a shell or watching a run finish. Everything else is navigation to one of those two.

## Product Purpose

Farol is a desktop terminal workspace with runnable pipelines. It opens a project folder, gives it tabs and splits backed by the machine's own default shell, and runs named pipelines whose steps are either real commands or prompts handed to Claude, Codex, Cursor, OpenCode, or OMP, streaming into their own tab.

It exists because the two halves of that workflow normally live apart: a terminal that is faithful but has no memory of your sequences, and a task runner that remembers but replaces your shell with a worse one. Farol refuses the trade. Pipelines are stored in the project at `.farol/pipelines.json` so they can be committed and shared, and runs are tracked per branch so a green result on `main` never masquerades as a green result on the branch you just checked out.

Success looks like a developer forgetting Farol is an app. Panes behave like their own terminal, prompts and aliases and PATH intact, full-screen programs rendering properly. The product has worked when the only thing that felt notable was that the pipeline was one click away.

## Brand Personality

**Native, invisible, precise.**

*Native:* Farol speaks macOS. It borrows the platform's vocabulary (system materials, SF Pro and SF Mono, traffic lights, standard shortcuts) instead of inventing a parallel one. A user who knows the Mac already knows this app.

*Invisible:* Chrome recedes so content dominates. The terminal is the hero and the interface is scaffolding around it. Confidence here reads as restraint, not as decoration.

*Precise:* Dense but never cramped. Small type, tight spacing, and exact alignment are correct for an operator tool, provided every value is deliberate. Sloppiness at this scale is immediately visible.

Voice is quiet and factual. Labels are nouns and verbs, not slogans. "No Project Open." "Not run on feature/x." When git refuses a checkout, the message is shown rather than softened. The tone never congratulates the user and never apologizes on the machine's behalf.

## Anti-references

- **Generic Electron app.** Web conventions leaking into a desktop window: browser-styled buttons, the wrong font stack, non-native scrollbars, hover states that feel like a webpage. If it reads as a website in a frame, it has failed.
- **CI dashboard (Jenkins, GitLab pipelines).** Heavy tables, status-badge soup, cluttered configuration forms, chrome competing with content. Pipelines here are a short readable chain, not an admin console.
- **Neon hacker terminal.** Matrix green on black, glow effects, cyberpunk styling, decorative monospace on things that are not code. The terminal is real work, not a stage set.
- **AI-product gradient SaaS.** Purple and blue gradients, glassmorphism as decoration, hero-metric cards, sparkle icons attached to anything touching a model. AI steps are just steps that shell out to a CLI, and should look like it.

## Design Principles

**The terminal is the hero.** Every pixel of chrome is a tax on the content. Before adding a surface, panel, or badge, establish what it takes away from the pane it borders. Panes stay opaque and high-contrast even when the surrounding chrome goes translucent.

**Borrow the platform, don't reinvent it.** Where macOS has an established answer (materials, shortcuts, window controls, scrollbars, type ramp), use it. Novelty in the shell of the app spends the user's attention without returning anything.

**Pass through, don't interpret.** The product's core promise is fidelity: the user's shell, exit codes, escape sequences, and error messages arrive intact. This extends to the interface. Show what happened, including git refusing a checkout or a CLI missing from PATH. Never swallow, soften, or summarize a real result.

**State must be honest about its scope.** A result belongs to a branch, a directory, and a moment. The interface says which one. Stale is labeled stale (amber once the checkout has moved on), other-branch results are filed under other branches, and nothing green is shown where nothing green was earned.

**Keyboard first, pointer second.** The user's hands are on the keys. Every frequent action has a shortcut, focus is always visible, and the mouse is for the things that genuinely want direct manipulation, like dragging a divider or reordering a step.

## Accessibility & Inclusion

- **Target: WCAG 2.1 AA.** Body text, labels, and interactive controls meet 4.5:1 against their actual surface; large text and UI boundaries meet 3:1. Working UI is small (10px to 13px), so dim metadata is the most likely failure point and should be checked against the surface it sits on.
- **Reduced motion.** Honor `prefers-reduced-motion`. The spin and pulse keyframes used for run status must degrade to a static or opacity-only state, never disappearing the status signal itself.
- **Full keyboard operability.** Every action reachable by pointer is reachable by keyboard, with a visible focus indicator that survives on both opaque and translucent chrome. Focus order follows visual order. Nothing traps focus except a modal that can be dismissed with Escape.
- **Status is never color alone.** Pass, fail, skipped, and stale carry a glyph or word alongside the green, red, grey, or amber. Run-log line kinds must stay distinguishable without color vision.
- **Terminal fidelity is an accessibility feature.** Users who rely on their own shell configuration (custom prompts, high-contrast themes, larger fonts) keep it. Farol does not restyle the pane contents.
