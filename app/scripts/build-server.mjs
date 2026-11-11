// Builds the headless Farol server that the desktop app installs on a Remote machine.
//
//   out/server/farol-server.js   the backend (electron/server.ts)
//   out/server/mcp.js, git-hook.js, codex-hook.js   the scripts agents and git start
//   out/server/package.json      node-pty, installed on the remote by `npm install`
//
// Plain Node, CommonJS, everything bundled except node-pty (native, built on
// the remote). `electron` is replaced by a small headless stand-in.
import { build } from 'esbuild'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = join(root, 'out', 'server')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const ptyVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'node-pty', 'package.json'), 'utf8')).version

rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: {
    'farol-server': join(root, 'electron/server.ts'),
    mcp: join(root, 'electron/mcp.ts'),
    'git-hook': join(root, 'electron/git-hook.ts'),
    'codex-hook': join(root, 'electron/codex-hook.ts')
  },
  outdir,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  logLevel: 'warning',
  alias: {
    electron: join(root, 'electron/headless-electron.ts'),
    'node-pty': join(root, 'electron/pty-lazy.ts')
  },
  define: {
    __FAROL_VERSION__: JSON.stringify(pkg.version),
    // electron-vite fills `import.meta.env.MAIN_VITE_*`; do the same from the build environment.
    'import.meta.env.MAIN_VITE_FAROL_SERVICE_URL': JSON.stringify(process.env.MAIN_VITE_FAROL_SERVICE_URL ?? '')
  }
})

writeFileSync(
  join(outdir, 'package.json'),
  JSON.stringify(
    { name: 'farol-server', version: pkg.version, private: true, dependencies: { 'node-pty': ptyVersion } },
    null,
    2
  ) + '\n'
)
console.log(`farol-server ${pkg.version} → ${outdir}`)
