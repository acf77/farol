# Farol design

How Farol should feel. This is the bar for every screen, string, and interaction in the app, the landing page, and the docs. Exact colors, sizes, and component specs live in [`app/DESIGN.md`](app/DESIGN.md). Where the two disagree, this file wins, and `app/DESIGN.md` should be brought in line.

## The feel

Calm, confident, and quiet. Farol should feel like a well-made Mac tool built by people who care about craft. It's not a dashboard, a website in a frame, or an AI product.

Think of a workshop at night: warm, dark, focused, everything within reach and nothing shouting. You should be able to work in it for hours and never notice the interface. You only notice that the work went well.

## Principles

**Restraint is the style.** Dark, warm surfaces and one soft lime accent, used sparingly so whatever it touches matters: the main action, what's selected, what passed. If a screen has a lot of color, the colors have stopped meaning anything.

**Room to breathe.** Give each thing space. One idea per area, a clear order to read in, nothing competing for attention. Dense is fine when the content is dense, like a run log or a diff. Chrome shouldn't be dense.

**Native, not novel.** Speak macOS: system type, familiar controls, standard shortcuts. Small, precise type and exact alignment. Novelty in the shell of the app spends attention and gives nothing back.

**Show the real thing.** The work is the hero: the agent's changes, the pipeline's results, the user's own terminal. Show what actually happened, including errors, in plain words. Never dress it up, soften it, or hide it behind a summary.

**Honest state.** A result belongs to a branch and a moment, so say which. Nothing looks green unless it was earned here, now. Status always comes with a word or a glyph, never color alone.

**Tactile, not flashy.** Small touches reward attention: a hover that warms, a hold-to-confirm that fills, a dot that pulses while something runs. Motion is short and purposeful, and it stops for people who ask for less.

## Voice

Write like a senior developer talking to a peer. Short, concrete sentences about what the user does and what happened. Dry, honest, a little opinionated.

- Say what happened: "Lint failed on 3 files", not "Oops! Something went wrong."
- Name the action: "Run again", "Fix in Chat", "Execute plan".
- Don't congratulate, don't apologize for the machine, don't hype.
- Don't use exclamation marks, emoji, or marketing words in the product.

## Not this

- **The generic Electron app.** Web buttons, the wrong fonts, web scrollbars. If it reads as a website in a frame, redo it.
- **The CI dashboard.** Tables of badges, walls of settings, chrome fighting the content.
- **The AI product.** Purple gradients, glow, sparkles on everything, glass for decoration, hero metrics. An AI step is just a step.
- **The hacker terminal.** Neon green, glow, monospace used as decoration on things that aren't code.
- **Noise.** Invented numbers, filler copy, decoration that carries no information.

## Before you ship a screen

- Does it look like it belongs next to the rest of Farol, and on a Mac?
- Is the lime doing one job, and only where it matters?
- Can you tell what to do first without reading everything?
- Does every status have a word, and is it true for this branch?
- Could you cut an element, a border, or a sentence and lose nothing?
- Does it still work from the keyboard, with focus visible, and with reduced motion?
