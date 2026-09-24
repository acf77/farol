import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listProjectDir,
  listProjectFiles,
  MAX_ATTACHMENT_BYTES,
  MAX_PROJECT_FILE_BYTES,
  normalizeRelPath,
  readProjectFile,
  saveChatAttachment,
  writeProjectFile
} from './files'

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

  it.each(['document.PDF', 'page.html', 'page.htm', 'notes.txt', 'README'])(
    'saves %s without changing its contents',
    (name) => {
      const root = tmp()
      const data = Buffer.from([0, 127, 128, 255])
      const saved = saveChatAttachment(root, name, data)
      expect(saved).toBeTruthy()
      expect(fs.readFileSync(saved!)).toEqual(data)
    }
  )

  it('keeps files with the same name separate', () => {
    const root = tmp()
    const first = saveChatAttachment(root, 'document.pdf', Buffer.from('first'))
    const second = saveChatAttachment(root, 'document.pdf', Buffer.from('second'))
    expect(first).not.toBe(second)
    expect(fs.readFileSync(first!, 'utf8')).toBe('first')
    expect(fs.readFileSync(second!, 'utf8')).toBe('second')
  })

  it('rejects oversized files', () => {
    const root = tmp()
    expect(
      saveChatAttachment(root, 'big.png', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))
    ).toBeNull()
  })
})

describe('normalizeRelPath', () => {
  it('rejects escapes, absolutes, and NUL', () => {
    expect(normalizeRelPath('../secret')).toBeNull()
    expect(normalizeRelPath('foo/../../etc')).toBeNull()
    expect(normalizeRelPath('/etc/passwd')).toBeNull()
    expect(normalizeRelPath('a\0b')).toBeNull()
    expect(normalizeRelPath('src/App.tsx')).toBe('src/App.tsx')
    expect(normalizeRelPath('')).toBe('')
  })
})

describe('listProjectDir', () => {
  it('lists one directory and skips node_modules', () => {
    const root = tmp()
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src', 'App.tsx'), '')
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1')
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), '')

    const listed = listProjectDir(root)
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.entries.map((e) => e.path)).toEqual(['src', '.env'])
    expect(listed.entries.find((e) => e.path === 'src')?.kind).toBe('dir')
    expect(listProjectDir(root, 'src')).toMatchObject({
      ok: true,
      entries: [{ name: 'App.tsx', path: 'src/App.tsx', kind: 'file' }]
    })
  })

  it('rejects paths outside the project', () => {
    const root = tmp()
    expect(listProjectDir(root, '..').ok).toBe(false)
  })
})

describe('readProjectFile and writeProjectFile', () => {
  it('reads UTF-8 text and preserves CRLF on save', () => {
    const root = tmp()
    fs.writeFileSync(path.join(root, 'notes.txt'), 'a\r\nb\r\n')
    const read = readProjectFile(root, 'notes.txt')
    expect(read).toMatchObject({ ok: true, content: 'a\nb\n', lineEnding: 'crlf' })
    if (!read.ok) return
    const written = writeProjectFile(root, 'notes.txt', 'a\nb\nc\n', { expectedMtimeMs: read.mtimeMs })
    expect(written.ok).toBe(true)
    expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe('a\r\nb\r\nc\r\n')
  })

  it('rejects binary, oversize, escapes, and writes without a prior read', () => {
    const root = tmp()
    const outside = tmp()
    fs.writeFileSync(path.join(root, 'ok.txt'), 'hi')
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2]))
    fs.writeFileSync(path.join(root, 'big.txt'), Buffer.alloc(MAX_PROJECT_FILE_BYTES + 1, 97))
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope')
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))

    expect(readProjectFile(root, 'bin.dat')).toMatchObject({
      ok: false,
      error: 'Binary or non-text file.'
    })
    expect(readProjectFile(root, 'big.txt')).toMatchObject({
      ok: false,
      error: 'File is larger than 2MB.'
    })
    expect(readProjectFile(root, '../secret.txt').ok).toBe(false)
    expect(readProjectFile(root, path.join(outside, 'secret.txt')).ok).toBe(false)
    expect(readProjectFile(root, 'link.txt').ok).toBe(false)
    expect(writeProjectFile(root, 'ok.txt', 'changed').ok).toBe(false)
  })

  it('reports an mtime conflict and overwrites only when asked', () => {
    const root = tmp()
    const file = path.join(root, 'ok.txt')
    fs.writeFileSync(file, 'one')
    const read = readProjectFile(root, 'ok.txt')
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(file, later, later)
    const blocked = writeProjectFile(root, 'ok.txt', 'two', { expectedMtimeMs: read.mtimeMs })
    expect(blocked).toMatchObject({ ok: false, conflict: true })
    expect(fs.readFileSync(file, 'utf8')).toBe('one')
    const forced = writeProjectFile(root, 'ok.txt', 'two', { overwrite: true })
    expect(forced.ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('two')
  })
})
