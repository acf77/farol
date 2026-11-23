/**
 * The project every case starts from: `tally`, a tiny ESM text-helpers library
 * whose checks run on plain Node (no install), so a pipeline takes a second.
 * Kept as strings rather than files so the app's own test, lint and type
 * tooling never mistakes the fixture's tests or scripts for Farol's.
 *
 * CONTRIBUTING.md states every rule a pipeline or hook enforces, so a careful
 * agent can pass each check the first time; one that skips the docs meets the
 * repair loop instead.
 */

import type { Pipeline, PipelineNode } from '../shared/types'

export const FIXTURE_FILES: Record<string, string> = {
  'package.json': `{
  "name": "tally",
  "version": "1.4.0",
  "description": "Small text helpers: slugify and formatBytes.",
  "type": "module",
  "exports": "./src/index.mjs",
  "scripts": {
    "test": "node --test",
    "lint": "node scripts/lint.mjs",
    "docs": "node scripts/check-docs.mjs",
    "release": "node scripts/release.mjs"
  }
}
`,
  '.gitignore': 'node_modules/\n',
  'README.md': `# tally

Small text helpers with no dependencies.

\`\`\`js
import { slugify, formatBytes } from 'tally'
\`\`\`

## API

### \`slugify(text)\`

Turns a title into a URL slug: lower case, ASCII letters and digits, words joined by single dashes.

\`\`\`js
slugify('Crème Brûlée') // 'creme-brulee'
\`\`\`

### \`formatBytes(bytes)\`

Formats a byte count for people.

\`\`\`js
formatBytes(512) // '512 B'
formatBytes(1536) // '1.5 KB'
\`\`\`
`,
  'CONTRIBUTING.md': `# Contributing to tally

- Code lives in \`src/\`, one module per helper, re-exported from \`src/index.mjs\`.
- Every exported function in \`src/\` has a JSDoc comment directly above it. The **Lint** pipeline checks this, and rejects \`console.log\`, \`debugger\` and \`var\`.
- Every function exported from \`src/index.mjs\` has a section in \`README.md\` that shows a call, like \`name(\`. The **Docs check** pipeline checks this, and catches common misspellings.
- Tests use \`node:test\` and live in \`test/\`, one file per module. The **Unit tests** pipeline runs them.
- Every change to \`src/\` adds a line under \`## Unreleased\` in \`CHANGELOG.md\`.
- Releases are cut only when a maintainer asks, with the **Release** pipeline. It bumps the version and dates the changelog.
`,
  'CHANGELOG.md': `# Changelog

## Unreleased

## 1.4.0

- formatBytes: add MB.
`,
  'src/index.mjs': `export { slugify } from './slugify.mjs'
export { formatBytes } from './format.mjs'
`,
  'src/slugify.mjs': `/**
 * Turn a title into a URL slug: lower case, ASCII letters and digits, words joined by dashes.
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\\s-]/g, '')
    .replace(/\\s/g, '-')
}
`,
  'src/format.mjs': `const UNITS = ['B', 'KB', 'MB']

/**
 * Format a byte count for people: 512 B, 1.5 KB, 3.2 MB.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? \`\${value} B\` : \`\${value.toFixed(1)} \${UNITS[unit]}\`
}
`,
  'test/slugify.test.mjs': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/slugify.mjs'

test('joins words with a dash', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
})

test('drops accents', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee')
})
`,
  'test/format.test.mjs': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatBytes } from '../src/format.mjs'

test('bytes stay in bytes', () => {
  assert.equal(formatBytes(512), '512 B')
})

test('kilobytes start at 1024', () => {
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
})

test('megabytes', () => {
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
})
`,
  'scripts/lint.mjs': `// Lint for tally: no debug output, no var, a JSDoc block above every export.
import fs from 'node:fs'
import path from 'node:path'

const problems = []
for (const name of fs.readdirSync('src').filter((f) => f.endsWith('.mjs')).sort()) {
  const file = path.join('src', name)
  const lines = fs.readFileSync(file, 'utf8').split('\\n')
  lines.forEach((line, i) => {
    const at = \`\${file}:\${i + 1}\`
    if (/\\bconsole\\.log\\b|\\bdebugger\\b/.test(line)) problems.push(\`\${at}  no debug output (console.log, debugger)\`)
    if (/^\\s*var\\s/.test(line)) problems.push(\`\${at}  use const or let, not var\`)
    const exported = /^export (?:async )?function (\\w+)/.exec(line)
    if (exported) {
      let j = i - 1
      while (j >= 0 && lines[j].trim() === '') j--
      if (j < 0 || !lines[j].trim().endsWith('*/')) {
        problems.push(\`\${at}  exported function \${exported[1]}() needs a JSDoc comment directly above it\`)
      }
    }
  })
}
if (problems.length) {
  console.error(problems.join('\\n'))
  console.error(\`\\n\${problems.length} lint problem\${problems.length === 1 ? '' : 's'}\`)
  process.exit(1)
}
console.log('lint: ok')
`,
  'scripts/check-docs.mjs': `// Docs check for tally: README covers every export, and no common misspellings.
import fs from 'node:fs'

const MISSPELLINGS = ['recieve', 'seperate', 'occured', 'definately', 'wich', 'untill']
const index = fs.readFileSync('src/index.mjs', 'utf8')
const names = new Set()
for (const m of index.matchAll(/export\\s*\\{([^}]*)\\}/g)) {
  for (const part of m[1].split(',')) {
    const name = part.trim().split(/\\s+as\\s+/).pop()
    if (name) names.add(name)
  }
}
for (const m of index.matchAll(/export (?:async )?function (\\w+)/g)) names.add(m[1])

const readme = fs.readFileSync('README.md', 'utf8')
const problems = []
for (const name of [...names].sort()) {
  if (!readme.includes(\`\${name}(\`)) problems.push(\`README.md does not document \${name}() (add a section that shows a call)\`)
}
for (const file of ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md']) {
  const text = fs.readFileSync(file, 'utf8').toLowerCase()
  for (const word of MISSPELLINGS) {
    if (new RegExp(\`\\\\b\${word}\\\\b\`).test(text)) problems.push(\`\${file}: misspelled "\${word}"\`)
  }
}
if (problems.length) {
  console.error(problems.join('\\n'))
  process.exit(1)
}
console.log(\`docs: ok (\${names.size} exports documented)\`)
`,
  'scripts/check-changelog.mjs': `// A change that touches src/ also adds to CHANGELOG.md. As a pre-commit hook it checks
// what is staged; run by hand (nothing staged) it checks the working tree.
import { execFileSync } from 'node:child_process'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
let changed = git('diff', '--cached', '--name-only').split('\\n').filter(Boolean)
if (!changed.length) changed = git('status', '--porcelain', '-uall').split('\\n').filter(Boolean).map((line) => line.slice(3))
if (changed.some((file) => file.startsWith('src/')) && !changed.includes('CHANGELOG.md')) {
  console.error('CHANGELOG.md: this change touches src/ but adds nothing under "## Unreleased" in CHANGELOG.md (see CONTRIBUTING.md).')
  process.exit(1)
}
console.log('changelog: ok')
`,
  'scripts/release.mjs': `// Release: bump the minor version and date the Unreleased changelog section.
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const [major, minor] = pkg.version.split('.').map(Number)
pkg.version = \`\${major}.\${minor + 1}.0\`
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n')
const log = fs.readFileSync('CHANGELOG.md', 'utf8')
fs.writeFileSync('CHANGELOG.md', log.replace('## Unreleased\\n', \`## Unreleased\\n\\n## \${pkg.version}\\n\`))
console.log(\`Released \${pkg.version}\`)
`
}

function shellPipeline(id: string, name: string, cmd: string, extra: Partial<Pipeline> = {}): Pipeline {
  const node: PipelineNode = { id: `${id}-step`, name, type: 'shell', cmd, after: [], x: 0, y: 0 }
  return { id, name, nodes: [node], ...extra }
}

/** Every pipeline a case can offer, by bare id (the id in `.farol/pipelines.json`). */
export const FIXTURE_PIPELINES: Record<string, Pipeline> = {
  lint: shellPipeline('lint', 'Lint', 'node scripts/lint.mjs'),
  'unit-tests': shellPipeline('unit-tests', 'Unit tests', 'node --test'),
  docs: shellPipeline('docs', 'Docs check', 'node scripts/check-docs.mjs'),
  release: shellPipeline('release', 'Release', 'node scripts/release.mjs'),
  changelog: shellPipeline('changelog', 'Changelog check', 'node scripts/check-changelog.mjs', { gitHooks: ['pre-commit'] })
}

export const DEFAULT_PIPELINES = ['lint', 'unit-tests', 'docs', 'release']
