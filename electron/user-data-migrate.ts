import fs from 'fs/promises'
import path from 'path'

/** Machine-local files that moved with the BuildFlow → Farol userData rename. */
export const USER_DATA_FILES = ['recent-projects.json', 'workspace.json'] as const
/** Electron used the package `name` in dev and `productName` when packaged. */
export const LEGACY_USER_DATA_NAMES = ['buildflow', 'BuildFlow'] as const

/**
 * Copy recents + workspace from a sibling BuildFlow userData dir into Farol's,
 * only when the destination file is missing. Safe on case-insensitive volumes.
 */
export async function migrateUserDataFiles(
  destDir: string,
  legacyNames: readonly string[] = LEGACY_USER_DATA_NAMES
): Promise<void> {
  const parent = path.dirname(destDir)
  let destKey: string
  try {
    destKey = (await fs.realpath(destDir)).toLowerCase()
  } catch {
    destKey = path.resolve(destDir).toLowerCase()
  }

  const tried = new Set<string>()
  for (const name of legacyNames) {
    const srcDir = path.join(parent, name)
    let srcKey: string
    try {
      srcKey = (await fs.realpath(srcDir)).toLowerCase()
    } catch {
      continue
    }
    if (srcKey === destKey || tried.has(srcKey)) continue
    tried.add(srcKey)
    for (const file of USER_DATA_FILES) await copyIfAbsent(srcDir, destDir, file)
  }
}

async function copyIfAbsent(srcDir: string, destDir: string, file: string): Promise<void> {
  const dest = path.join(destDir, file)
  const src = path.join(srcDir, file)
  try {
    await fs.access(dest)
    return
  } catch {
    /* dest missing — try copy */
  }
  try {
    await fs.access(src)
  } catch {
    return
  }
  await fs.mkdir(destDir, { recursive: true })
  await fs.copyFile(src, dest)
}
