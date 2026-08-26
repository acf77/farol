import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const candidates = [
  path.join(root, 'dist', 'mac-arm64', 'BuildFlow.app'),
  path.join(root, 'dist', 'mac', 'BuildFlow.app')
]
const src = candidates.find((p) => fs.existsSync(p))
if (!src) {
  console.error('install-app: BuildFlow.app not found in dist/ — run npm run dist first')
  process.exit(1)
}

const dest = '/Applications/BuildFlow.app'
const r = spawnSync('ditto', [src, dest], { stdio: 'inherit' })
if (r.status !== 0) process.exit(r.status ?? 1)
spawnSync('xattr', ['-cr', dest], { stdio: 'ignore' })
console.log(`Installed ${src} → ${dest}`)
console.log('Quit BuildFlow if it is open, then launch it from Applications.')
