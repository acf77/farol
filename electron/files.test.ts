import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { listProjectFiles, saveChatAttachment, MAX_ATTACHMENT_BYTES } from './files'

const dirs: string[] = []

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-files-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('listProjectFiles', () => {
  it('returns relative paths and skips node_modules', () => {
    const root = tmp()
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src', 'App.tsx'), '')
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), '')

    const files = listProjectFiles(root)
    expect(files).toContain('src/App.tsx')
    expect(files.some((f) => f.includes('node_modules'))).toBe(false)
  })

  it('filters by query', () => {
    const root = tmp()
    fs.writeFileSync(path.join(root, 'readme.md'), '')
    fs.writeFileSync(path.join(root, 'App.tsx'), '')
    expect(listProjectFiles(root, 'app')).toEqual(['App.tsx'])
  })
})

describe('saveChatAttachment', () => {
  it('writes images under .farol/attachments', () => {
    const root = tmp()
    const saved = saveChatAttachment(root, 'screenshot.png', Buffer.from('png-bytes'))
    expect(saved).toBeTruthy()
    expect(saved!.startsWith(root)).toBe(true)
    expect(fs.readFileSync(saved!, 'utf8')).toBe('png-bytes')
    expect(saved!).toContain(`${path.sep}.farol${path.sep}attachments${path.sep}`)
  })

  it('rejects non-image extensions', () => {
    const root = tmp()
    expect(saveChatAttachment(root, 'notes.txt', Buffer.from('nope'))).toBeNull()
  })

  it('rejects oversized images', () => {
    const root = tmp()
    expect(
      saveChatAttachment(root, 'big.png', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))
    ).toBeNull()
  })
})
