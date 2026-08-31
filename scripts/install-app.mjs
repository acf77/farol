import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const candidates = [
  path.join(root, 'dist', 'mac-arm64', 'Farol.app'),
  path.join(root, 'dist', 'mac', 'Farol.app')
]
const src = candidates.find((p) => fs.existsSync(p))
if (!src) {
  console.error('install-app: Farol.app not found in dist/ — run npm run dist first')
  process.exit(1)
}

const dest = '/Applications/Farol.app'
const r = spawnSync('ditto', [src, dest], { stdio: 'inherit' })
if (r.status !== 0) process.exit(r.status ?? 1)
spawnSync('xattr', ['-cr', dest], { stdio: 'ignore' })
// Force Launch Services to re-read CFBundleIconFile so Dock/Finder drop a
// cached Electron atom from an older BuildFlow/Farol install.
spawnSync('touch', [dest], { stdio: 'ignore' })
const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
if (fs.existsSync(lsregister)) {
  spawnSync(lsregister, ['-f', dest], { stdio: 'ignore' })
}
console.log(`Installed ${src} → ${dest}`)

// Pre-rename bundle — leave it up and it keeps writing `.buildflow/` / old
// userData after Farol's copy-once migration has already run.
const legacy = '/Applications/BuildFlow.app'
if (fs.existsSync(legacy)) {
  fs.rmSync(legacy, { recursive: true, force: true })
  console.log(`Removed legacy ${legacy}`)
}

console.log('Quit Farol if it is open, then launch it from Applications.')
