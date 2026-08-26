import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const dest = path.join(os.homedir(), '.buildflow', 'updates')

function zipName(dir, version) {
  const zips = fs.readdirSync(dir).filter((f) => /^BuildFlow-.*\.zip$/.test(f))
  return zips.find((f) => f.includes(`-${version}-`)) ?? zips.find((f) => f.includes(version)) ?? null
}

if (!fs.existsSync(dist)) {
  console.error('publish-local: dist/ is missing — run electron-builder first')
  process.exit(1)
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const zip = zipName(dist, pkg.version)
if (!zip) {
  console.error(`publish-local: no BuildFlow zip for ${pkg.version} in dist/`)
  process.exit(1)
}

fs.mkdirSync(dest, { recursive: true })
for (const f of fs.readdirSync(dest)) {
  if (f.endsWith('.zip') && f !== zip) fs.unlinkSync(path.join(dest, f))
}

const feed = `version: ${pkg.version}\npath: ${zip}\n`
fs.writeFileSync(path.join(dest, 'latest-mac.yml'), feed)
fs.copyFileSync(path.join(dist, zip), path.join(dest, zip))
console.log(`Published ${zip} (${pkg.version}) → ${dest}`)
