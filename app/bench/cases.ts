/**
 * The cases. Each one is a user message in the `tally` fixture, the checks
 * that say whether the agent used Farol's tools correctly, acceptance commands
 * that say whether the task is really done, and a reference: what a correct
 * agent does, which the tests run through the real controller to prove the
 * case can be passed and its checks are right.
 */

import fs from 'fs'
import path from 'path'
import { FIXTURE_FILES } from './fixture'
import {
  commitMessage,
  gitActions,
  gitFirstTry,
  neverSelects,
  noSelfGit,
  noSelfRun,
  noValidation,
  oneInProgress,
  planFinished,
  prBase,
  reselectsFailed,
  todoGone,
  todoHas,
  todosAllDone,
  todosSaved,
  todoTracked,
  todoUnchanged,
  validates
} from './grade'
import type { BenchCase } from './types'

// ---------------------------------------------------------------------------
// Helpers for references and acceptance

function edit(repo: string, rel: string, change: (text: string) => string): void {
  const file = path.join(repo, rel)
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const after = change(before)
  if (after === before) throw new Error(`reference edit changed nothing in ${rel}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, after)
}

/** The catalog id managed Chat gave a fixture pipeline, read from the prompt like an agent would. */
export function catalogId(prompt: string, bare: string): string {
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = new RegExp(`\\[id: (\\S*managed-pipeline:${escaped})\\]`).exec(prompt)
  if (!found) throw new Error(`pipeline ${bare} is not in the catalog`)
  return found[1]
}

const select = (prompt: string, ...bare: string[]): string =>
  `FAROL_PIPELINES: ${JSON.stringify(bare.map((id) => catalogId(prompt, id)))}`

/** A Node check run in the final tree; `js` must not contain single quotes. */
const node = (js: string): string => `node --input-type=module -e '${js}'`

const SLUGIFY_FIXED = (text: string): string => text.replace(".replace(/\\s/g, '-')", ".replace(/[\\s-]+/g, '-')\n    .replace(/^-+|-+$/g, '')")
const FORMAT_GB = (text: string): string => text.replace("const UNITS = ['B', 'KB', 'MB']", "const UNITS = ['B', 'KB', 'MB', 'GB']")
const changelog = (line: string) => (text: string): string => text.replace('## Unreleased\n', `## Unreleased\n\n- ${line}\n`)

const ACCEPT = {
  tests: { name: 'unit tests', cmd: 'node --test' },
  lint: { name: 'lint', cmd: 'node scripts/lint.mjs' },
  docs: { name: 'docs', cmd: 'node scripts/check-docs.mjs' },
  slugify: {
    name: 'slugify collapses dashes',
    cmd: node(
      'import { slugify } from "./src/slugify.mjs"; const got = [slugify("Hello   World"), slugify("  Rock & Roll  "), slugify("a - b")]; if (got.join() !== "hello-world,rock-roll,a-b") { console.error(got); process.exit(1) }'
    )
  },
  gb: {
    name: 'formatBytes knows GB',
    cmd: node('import { formatBytes } from "./src/format.mjs"; const got = formatBytes(3 * 1024 ** 3); if (got !== "3.0 GB") { console.error(got); process.exit(1) }')
  }
}

// ---------------------------------------------------------------------------
// Pipelines: which ones the agent picks after a change, and that it never runs them itself

const bugfix: BenchCase = {
  id: 'pipelines/bugfix',
  category: 'pipelines',
  title: 'A bug fix in src/ selects the tests',
  prompt:
    "slugify('Hello   World') returns 'hello---world'. Runs of spaces or dashes should collapse into a single dash, and a slug should never start or end with a dash. Please fix it.",
  changesFiles: true,
  checks: [validates(['unit-tests']), validates(['lint'], false), neverSelects(['release']), noSelfRun()],
  mcpChecks: [validates(['unit-tests']), neverSelects(['release']), noSelfRun()],
  acceptance: [ACCEPT.slugify, ACCEPT.tests, ACCEPT.lint],
  reference: ({ repo, prompt }) => {
    edit(repo, 'src/slugify.mjs', SLUGIFY_FIXED)
    edit(repo, 'test/slugify.test.mjs', (t) => `${t}\ntest('collapses runs of spaces and dashes', () => {\n  assert.equal(slugify('Hello   World'), 'hello-world')\n  assert.equal(slugify(' a - b '), 'a-b')\n})\n`)
    edit(repo, 'CHANGELOG.md', changelog('slugify: collapse runs of spaces and dashes.'))
    return `Fixed slugify to collapse runs of spaces and dashes.\n${select(prompt, 'unit-tests', 'lint')}`
  }
}

const questionOnly: BenchCase = {
  id: 'pipelines/question-only',
  category: 'pipelines',
  title: 'A question changes nothing and selects nothing',
  prompt: "How does formatBytes decide which unit to use? Just explain it, don't change anything.",
  changesFiles: false,
  checks: [noValidation(), noSelfRun()],
  mcpChecks: [noValidation()],
  reference: () => 'It divides by 1024 until the value is under 1024 or it runs out of units.\nFAROL_PIPELINES: []'
}

const docsTypo: BenchCase = {
  id: 'pipelines/docs-typo',
  category: 'pipelines',
  title: 'A README fix selects the docs check',
  files: {
    'README.md': FIXTURE_FILES['README.md'].replace('Formats a byte count for people.', "Formats a byte count for people. You'll recieve a short string like `1.5 KB`.")
  },
  prompt: "There's a typo in README.md ('recieve'). Fix it.",
  changesFiles: true,
  checks: [validates(['docs']), neverSelects(['release']), noSelfRun()],
  mcpChecks: [validates(['docs']), neverSelects(['release'])],
  acceptance: [ACCEPT.docs, { name: 'typo gone', cmd: '! grep -qi recieve README.md' }],
  reference: ({ repo, prompt }) => {
    edit(repo, 'README.md', (t) => t.replace('recieve', 'receive'))
    return `Fixed the typo.\n${select(prompt, 'docs')}`
  }
}

const failingTests: BenchCase = {
  id: 'pipelines/failing-tests',
  category: 'pipelines',
  title: 'Failing tests are fixed without running the tests by hand',
  files: { 'src/format.mjs': FIXTURE_FILES['src/format.mjs'].replace('while (value >= 1024', 'while (value > 1024') },
  prompt: 'The unit tests fail on main. Find out why and fix it.',
  changesFiles: true,
  checks: [validates(['unit-tests']), neverSelects(['release']), noSelfRun(true)],
  mcpChecks: [validates(['unit-tests']), noSelfRun()],
  acceptance: [ACCEPT.tests, ACCEPT.lint],
  reference: ({ repo, prompt }) => {
    edit(repo, 'src/format.mjs', (t) => t.replace('while (value > 1024', 'while (value >= 1024'))
    return `formatBytes(1024) stayed in bytes because the loop compared with >. Fixed.\n${select(prompt, 'unit-tests')}`
  }
}

const TRUNCATE = `/**
 * Shorten text to at most \`max\` characters, ending with an ellipsis when it was cut.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
  if (text.length <= max) return text
  return \`\${text.slice(0, Math.max(0, max - 1))}…\`
}
`

const featureRepair: BenchCase = {
  id: 'pipelines/feature',
  category: 'pipelines',
  title: 'A new helper is validated by tests, lint and docs (repairs if needed)',
  prompt:
    "Add a truncate(text, max) helper to tally. It returns the text unchanged when it fits in max characters; otherwise it cuts it and ends it with '…' so the result is exactly max characters long. Export it from src/index.mjs and add unit tests.",
  changesFiles: true,
  checks: [
    validates(['unit-tests', 'lint']),
    validates(['docs'], false),
    neverSelects(['release']),
    noSelfRun(),
    reselectsFailed()
  ],
  acceptance: [
    {
      name: 'truncate works',
      cmd: node(
        'import { truncate } from "./src/index.mjs"; const got = [truncate("hello world", 5), truncate("hi", 5), truncate("abcde", 5)]; if (got.join() !== "hell…,hi,abcde") { console.error(got); process.exit(1) }'
      )
    },
    ACCEPT.tests,
    ACCEPT.lint,
    ACCEPT.docs
  ],
  reference: ({ repo, prompt }) => {
    fs.writeFileSync(path.join(repo, 'src/truncate.mjs'), TRUNCATE)
    edit(repo, 'src/index.mjs', (t) => `${t}export { truncate } from './truncate.mjs'\n`)
    fs.writeFileSync(
      path.join(repo, 'test/truncate.test.mjs'),
      `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { truncate } from '../src/truncate.mjs'\n\ntest('keeps short text', () => {\n  assert.equal(truncate('hi', 5), 'hi')\n})\n\ntest('cuts long text to max with an ellipsis', () => {\n  assert.equal(truncate('hello world', 5), 'hell…')\n})\n`
    )
    edit(repo, 'README.md', (t) => `${t}\n### \`truncate(text, max)\`\n\nShortens text to at most \`max\` characters, ending with \`…\` when it was cut.\n\n\`\`\`js\ntruncate('hello world', 5) // 'hell…'\n\`\`\`\n`)
    edit(repo, 'CHANGELOG.md', changelog('Add truncate().'))
    return `Added truncate with tests and docs.\n${select(prompt, 'unit-tests', 'lint', 'docs')}`
  }
}

const releaseWhenAsked: BenchCase = {
  id: 'pipelines/release',
  category: 'pipelines',
  title: 'An explicit request runs the Release pipeline through Farol',
  prompt: "Cut a release: run the Release pipeline. Don't edit any files yourself.",
  changesFiles: false,
  checks: [validates(['release']), noSelfRun(true)],
  mcpChecks: [validates(['release']), noSelfRun(true)],
  acceptance: [
    {
      name: 'version bumped to 1.5.0',
      cmd: node('import fs from "node:fs"; const v = JSON.parse(fs.readFileSync("package.json", "utf8")).version; if (v !== "1.5.0") { console.error(v); process.exit(1) }')
    }
  ],
  reference: ({ prompt }) => `Selecting the Release pipeline.\n${select(prompt, 'release')}`
}

// ---------------------------------------------------------------------------
// Git: FAROL_GIT lines, in order, only when asked, never from the shell

const commitAfterChange: BenchCase = {
  id: 'git/commit',
  category: 'git',
  title: 'A change is committed through Farol (not pushed)',
  git: { enabled: true },
  prompt: "Add GB to formatBytes, so that formatBytes(3 * 1024 ** 3) prints '3.0 GB'.",
  changesFiles: true,
  checks: [gitActions(['commit']), noSelfGit(), commitMessage(), validates(['unit-tests'], false)],
  acceptance: [
    ACCEPT.gb,
    ACCEPT.tests,
    { name: 'change committed', cmd: 'test "$(git rev-list --count HEAD)" -ge 2 && git diff --quiet HEAD -- src/format.mjs' },
    { name: 'not pushed', cmd: 'test "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)"' }
  ],
  reference: ({ repo, prompt }) => {
    edit(repo, 'src/format.mjs', FORMAT_GB)
    edit(repo, 'test/format.test.mjs', (t) => `${t}\ntest('gigabytes', () => {\n  assert.equal(formatBytes(3 * 1024 ** 3), '3.0 GB')\n})\n`)
    edit(repo, 'CHANGELOG.md', changelog('formatBytes: add GB.'))
    return `Added GB.\nFAROL_GIT: {"action":"commit","message":"formatBytes: add GB"}\n${select(prompt, 'unit-tests', 'lint')}`
  }
}

const commitPushPr: BenchCase = {
  id: 'git/commit-push-pr',
  category: 'git',
  title: 'Commit, push and a pull request, in order, when asked',
  git: { enabled: true, branch: 'fix/slugify-dashes' },
  prompt:
    "slugify('Hello   World') returns 'hello---world'; runs of spaces or dashes should become a single dash. Fix it, then commit, push the branch and open a pull request against main.",
  changesFiles: true,
  checks: [gitActions(['commit', 'push', 'create_pr']), prBase('main'), noSelfGit(), commitMessage(), validates(['unit-tests'], false)],
  mcpChecks: [gitActions(['commit', 'push', 'create_pr']), prBase('main'), noSelfGit(), validates(['unit-tests'], false)],
  acceptance: [
    ACCEPT.slugify,
    { name: 'branch pushed', cmd: 'git fetch -q origin && test "$(git rev-parse HEAD)" = "$(git rev-parse origin/fix/slugify-dashes)"' }
  ],
  reference: ({ repo, prompt }) => {
    edit(repo, 'src/slugify.mjs', SLUGIFY_FIXED)
    edit(repo, 'CHANGELOG.md', changelog('slugify: collapse runs of spaces and dashes.'))
    return [
      'Fixed slugify.',
      'FAROL_GIT: {"action":"commit","message":"slugify: collapse runs of spaces and dashes"}',
      'FAROL_GIT: {"action":"push"}',
      'FAROL_GIT: {"action":"create_pr","base":"main","title":"slugify: collapse runs of spaces and dashes"}',
      select(prompt, 'unit-tests', 'lint')
    ].join('\n')
  }
}

const noCommitOnQuestion: BenchCase = {
  id: 'git/question',
  category: 'git',
  title: 'A question commits nothing',
  git: { enabled: true },
  prompt: "What does the Lint pipeline check? Don't change anything.",
  changesFiles: false,
  checks: [gitActions([]), noValidation(), noSelfGit()],
  reference: () => 'It rejects console.log, debugger and var, and wants JSDoc above every export.\nFAROL_PIPELINES: []'
}

const preCommitHook: BenchCase = {
  id: 'git/pre-commit-hook',
  category: 'git',
  title: 'A commit the pre-commit hook blocks is repaired and sent again',
  git: { enabled: true, hooks: { 'pre-commit': 'node scripts/check-changelog.mjs' } },
  pipelines: ['lint', 'unit-tests', 'docs', 'release', 'changelog'],
  prompt: "Add GB to formatBytes, so that formatBytes(3 * 1024 ** 3) prints '3.0 GB'.",
  changesFiles: true,
  checks: [gitActions(['commit']), noSelfGit(), gitFirstTry(), validates(['unit-tests'], false)],
  acceptance: [
    ACCEPT.gb,
    { name: 'committed with a changelog line', cmd: 'git diff --quiet HEAD -- src/format.mjs CHANGELOG.md && git show --name-only --format= HEAD | grep -qx CHANGELOG.md' }
  ],
  reference: ({ repo, prompt }) => {
    edit(repo, 'src/format.mjs', FORMAT_GB)
    edit(repo, 'CHANGELOG.md', changelog('formatBytes: add GB.'))
    return `Added GB.\nFAROL_GIT: {"action":"commit","message":"formatBytes: add GB"}\n${select(prompt, 'unit-tests', 'changelog')}`
  }
}

// ---------------------------------------------------------------------------
// Todos: FAROL_TODOS replaces the whole list, so every update must carry the rest of it

const ADD_TRUNCATE = { content: 'Add a truncate helper', status: 'pending', priority: 'medium' } as const
const todoLine = (todos: { content: string; status: string; priority: string }[]): string => `FAROL_TODOS: ${JSON.stringify(todos)}`

const todoAdd: BenchCase = {
  id: 'todos/add',
  category: 'todos',
  title: 'A new todo is added and the list kept',
  todos: [{ ...ADD_TRUNCATE }],
  prompt: "Add a high-priority todo to write a migration guide for v2. Don't start on it now.",
  changesFiles: false,
  checks: [todosSaved(), todoHas(/migration guide/i, { status: ['pending'], priority: 'high' }), todoUnchanged('Add a truncate helper'), noValidation()],
  reference: () =>
    `Added it.\n${todoLine([ADD_TRUNCATE, { content: 'Write a migration guide for v2', status: 'pending', priority: 'high' }])}\nFAROL_PIPELINES: []`
}

const SLUGIFY_TODO = 'Make slugify collapse runs of spaces and dashes into one dash'
const GB_TODO = 'Add GB support to formatBytes'

const todoFinish: BenchCase = {
  id: 'todos/finish',
  category: 'todos',
  title: 'The todo in progress is done and marked completed',
  todos: [
    { content: SLUGIFY_TODO, status: 'in_progress', priority: 'high' },
    { content: GB_TODO, status: 'pending', priority: 'medium' }
  ],
  prompt: "Finish the todo that's in progress.",
  changesFiles: true,
  checks: [
    todosSaved(),
    todoHas(/slugify/i, { status: ['completed'] }),
    todoHas(/GB support/i, { status: ['pending', 'in_progress'] }),
    oneInProgress(),
    validates(['unit-tests'], false)
  ],
  acceptance: [ACCEPT.slugify, ACCEPT.tests],
  reference: ({ repo, prompt }) => {
    edit(repo, 'src/slugify.mjs', SLUGIFY_FIXED)
    edit(repo, 'CHANGELOG.md', changelog('slugify: collapse runs of spaces and dashes.'))
    return `Done.\n${todoLine([
      { content: SLUGIFY_TODO, status: 'completed', priority: 'high' },
      { content: GB_TODO, status: 'pending', priority: 'medium' }
    ])}\n${select(prompt, 'unit-tests', 'lint')}`
  }
}

const todoTrack: BenchCase = {
  id: 'todos/track',
  category: 'todos',
  title: 'A multi-step request is tracked in the list and closed',
  prompt:
    'Three changes, tracked in the todo list as you go: 1) add GB to formatBytes; 2) add a capitalize(text) helper that upper-cases the first letter, exported from src/index.mjs, with unit tests; 3) document capitalize in README.md.',
  changesFiles: true,
  checks: [todosSaved(), todoTracked(3), todosAllDone(), oneInProgress(), validates(['unit-tests', 'lint', 'docs'], false)],
  acceptance: [
    ACCEPT.gb,
    {
      name: 'capitalize works',
      cmd: node('import { capitalize } from "./src/index.mjs"; const got = capitalize("hello world"); if (got !== "Hello world") { console.error(got); process.exit(1) }')
    },
    ACCEPT.tests,
    ACCEPT.lint,
    ACCEPT.docs
  ],
  reference: ({ repo, prompt }) => {
    edit(repo, 'src/format.mjs', FORMAT_GB)
    fs.writeFileSync(
      path.join(repo, 'src/capitalize.mjs'),
      `/**\n * Upper-case the first letter of text.\n * @param {string} text\n * @returns {string}\n */\nexport function capitalize(text) {\n  return text.charAt(0).toUpperCase() + text.slice(1)\n}\n`
    )
    edit(repo, 'src/index.mjs', (t) => `${t}export { capitalize } from './capitalize.mjs'\n`)
    fs.writeFileSync(
      path.join(repo, 'test/capitalize.test.mjs'),
      `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { capitalize } from '../src/capitalize.mjs'\n\ntest('upper-cases the first letter', () => {\n  assert.equal(capitalize('hello world'), 'Hello world')\n})\n`
    )
    edit(repo, 'README.md', (t) => `${t}\n### \`capitalize(text)\`\n\nUpper-cases the first letter.\n\n\`\`\`js\ncapitalize('hello') // 'Hello'\n\`\`\`\n`)
    edit(repo, 'CHANGELOG.md', changelog('Add GB to formatBytes, and capitalize().'))
    const done = (content: string) => ({ content, status: 'completed', priority: 'medium' })
    return `All three done.\n${todoLine([done('Add GB to formatBytes'), done('Add capitalize(text) with tests'), done('Document capitalize in README.md')])}\n${select(prompt, 'unit-tests', 'lint', 'docs')}`
  }
}

const MIGRATION_TODO = 'Write a v2 migration guide'

const todoCancel: BenchCase = {
  id: 'todos/cancel',
  category: 'todos',
  title: 'A dropped item leaves the list; the rest stays',
  todos: [
    { content: MIGRATION_TODO, status: 'pending', priority: 'high' },
    { content: GB_TODO, status: 'pending', priority: 'medium' },
    { ...ADD_TRUNCATE, priority: 'low' }
  ],
  prompt: "We're not adding GB support to formatBytes after all. Update the todo list.",
  changesFiles: false,
  checks: [todosSaved(), todoGone(/GB support/i), todoUnchanged(MIGRATION_TODO), todoUnchanged(ADD_TRUNCATE.content), noValidation()],
  reference: () =>
    `Cancelled it.\n${todoLine([
      { content: MIGRATION_TODO, status: 'pending', priority: 'high' },
      { content: GB_TODO, status: 'cancelled', priority: 'medium' },
      { ...ADD_TRUNCATE, priority: 'low' }
    ])}\nFAROL_PIPELINES: []`
}

// ---------------------------------------------------------------------------
// Plan mode: read-only, ends with a finished plan

const planReadOnly: BenchCase = {
  id: 'plan/read-only',
  category: 'pipelines',
  title: 'Plan mode changes nothing and ends with a finished plan',
  mode: 'plan',
  prompt: "Plan how we'd make slugify locale-aware, for example German 'ß' becoming 'ss'. Don't implement anything yet.",
  changesFiles: false,
  checks: [planFinished(), noValidation(), gitActions([])],
  reference: () => '1. Add a transliteration table.\n2. Apply it before stripping.\n3. Test ß, æ, ø.\nFAROL_PLAN: finished'
}

export const CASES: BenchCase[] = [
  bugfix,
  questionOnly,
  docsTypo,
  failingTests,
  featureRepair,
  releaseWhenAsked,
  commitAfterChange,
  commitPushPr,
  noCommitOnQuestion,
  preCommitHook,
  todoAdd,
  todoFinish,
  todoTrack,
  todoCancel,
  planReadOnly
]

/** Cases whose id matches any of `patterns` (`git/*`, `todos/add`, `all`). */
export function selectCases(patterns: string[]): BenchCase[] {
  if (!patterns.length || patterns.includes('all')) return CASES
  const tests = patterns.map((pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`))
  const picked = CASES.filter((c) => tests.some((test) => test.test(c.id)))
  if (!picked.length) throw new Error(`No case matches ${patterns.join(', ')}. Cases: ${CASES.map((c) => c.id).join(', ')}`)
  return picked
}
