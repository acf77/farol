import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateUserDataFiles } from './user-data-migrate'

const dirs: string[] = []

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-userdata-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('migrateUserDataFiles', () => {
  it('copies missing recents and workspace from a legacy sibling', async () => {
    const parent = tmp()
    const legacy = path.join(parent, 'buildflow')
    const dest = path.join(parent, 'farol')
    fs.mkdirSync(legacy)
    fs.writeFileSync(path.join(legacy, 'recent-projects.json'), '[{"path":"/x"}]')
    fs.writeFileSync(path.join(legacy, 'workspace.json'), '{"lastProject":"/x"}')

    await migrateUserDataFiles(dest, ['buildflow'])

    expect(fs.readFileSync(path.join(dest, 'recent-projects.json'), 'utf8')).toBe('[{"path":"/x"}]')
    expect(fs.readFileSync(path.join(dest, 'workspace.json'), 'utf8')).toBe('{"lastProject":"/x"}')
  })

  it('does not overwrite files that already exist in the new dir', async () => {
    const parent = tmp()
    const legacy = path.join(parent, 'buildflow')
    const dest = path.join(parent, 'farol')
    fs.mkdirSync(legacy)
    fs.mkdirSync(dest)
    fs.writeFileSync(path.join(legacy, 'recent-projects.json'), '[{"path":"/old"}]')
    fs.writeFileSync(path.join(dest, 'recent-projects.json'), '[{"path":"/new"}]')

    await migrateUserDataFiles(dest, ['buildflow'])

    expect(fs.readFileSync(path.join(dest, 'recent-projects.json'), 'utf8')).toBe('[{"path":"/new"}]')
  })

  it('is a no-op when the legacy dir is missing', async () => {
    const parent = tmp()
    const dest = path.join(parent, 'farol')
    await migrateUserDataFiles(dest, ['buildflow'])
    expect(fs.existsSync(dest)).toBe(false)
  })
})
