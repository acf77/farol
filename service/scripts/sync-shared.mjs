// The service reuses the pure TypeScript in app/shared. Copy it in so the
// service's imports (`../shared/...`) stay as they are. The copy is generated
// and git-ignored; never edit it here.
import { cpSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const service = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = join(service, '..', 'app')

rmSync(join(service, 'shared'), { recursive: true, force: true })
cpSync(join(app, 'shared'), join(service, 'shared'), {
  recursive: true,
  filter: (src) => !/\.test\.tsx?$/.test(src)
})
