/** Writes a gzipped checkout snapshot to stdout (same rules as desktop remote runs). */
import { checkoutSnapshot } from '../electron/checkout-snapshot'

const cwd = process.argv[2] ?? process.cwd()
checkoutSnapshot(cwd)
  .then(({ archive }) => {
    process.stdout.write(archive)
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
