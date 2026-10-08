// The service reuses the pure TypeScript in app/shared and the Vercel sandbox
// module in app/electron/sandbox.ts. Copy them in so the service's imports
// (`../shared/...`, `../electron/sandbox`) stay as they are. The copies are
// generated and git-ignored; never edit them here.
import { cpSync, mkdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const service = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = join(service, '..', 'app')

rmSync(join(service, 'shared'), { recursive: true, force: true })
cpSync(join(app, 'shared'), join(service, 'shared'), {
  recursive: true,
  filter: (src) => !/\.test\.tsx?$/.test(src)
})
mkdirSync(join(service, 'electron'), { recursive: true })
cpSync(join(app, 'electron', 'sandbox.ts'), join(service, 'electron', 'sandbox.ts'))
