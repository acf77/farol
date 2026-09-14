# Parked: Plan mode

`chat-mode.test.ts` covers `ChatModeSwitch`, which does not exist yet, so it fails
`tsc --noEmit`. `vitest.config.ts` exists only to give that test the `@shared` alias.

When Plan mode is built, move them back to `app/src/chat-mode.test.ts` and
`app/vitest.config.ts`. The behaviour they assert is specified in CONTEXT.md
under "Plan mode".
