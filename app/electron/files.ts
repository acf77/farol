/**
 * Lightweight project file listing for the composer @-picker and ⌘K palette.
 * Skips heavy / generated directories so the walk stays snappy on big repos.
 */

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { normalizeRelPath } from '../shared/rel-path'
import type {
  ProjectDirEntry,
  ProjectFileRead,
  ProjectFileWrite,
  ProjectFsResult,
  ProjectLineEnding,
  ProjectWriteOpts
} from '../shared/types'

const SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '.cache',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.farol',
  '.cursor',
  '.claude'
])

const MAX_FILES = 400
/** Maximum size of a project file the Code view will open or save. */
export const MAX_PROJECT_FILE_BYTES = 2 * 1024 * 1024
const BINARY_ERROR = 'Binary or non-text file.'
/** Maximum size of a saved chat attachment. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const ATTACHMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const ATTACHMENTS_IGNORE = '.farol/attachments/'

export function listProjectFiles(root: string, query = ''): string[] {
  if (typeof root !== 'string' || !root || !fs.existsSync(root)) return []
  const needle = query.trim().toLowerCase()
  const out: string[] = []

  const skipDir = (name: string): boolean => SKIP.has(name) || name.startsWith('.')
  const dirEntries = (dir: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return []
    }
  }
  const addFile = (full: string): void => {
    const rel = path.relative(root, full).split(path.sep).join('/')
    if (needle && !rel.toLowerCase().includes(needle)) return
    out.push(rel)
  }
  const walk = (dir: string): void => {
    for (const entry of dirEntries(dir)) {
      if (out.length >= MAX_FILES) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!skipDir(entry.name)) walk(full)
      } else if (entry.isFile()) {
        addFile(full)
      }
    }
  }

  walk(root)
  return out
}

function ensureAttachmentsIgnored(root: string): void {
  const ignorePath = path.join(root, '.gitignore')
  try {
    const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : ''
    if (existing.split(/\r?\n/).some((line) => line.trim() === ATTACHMENTS_IGNORE)) return
    const next = existing.endsWith('\n') || !existing ? existing : `${existing}\n`
    fs.writeFileSync(ignorePath, `${next}${ATTACHMENTS_IGNORE}\n`)
  } catch {
    // Best effort — the project may be read-only.
  }
}

function pruneOldAttachments(dir: string): void {
  const cutoff = Date.now() - ATTACHMENT_MAX_AGE_MS
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = path.join(dir, entry.name)
    try {
      const stat = fs.statSync(full)
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full)
    } catch {
      // Ignore stale entries we cannot read or remove.
    }
  }
}

/** Save a chat file under `.farol/attachments/` and return its absolute path. */
export function saveChatAttachment(root: string, name: string, data: Buffer): string | null {
  if (typeof root !== 'string' || !root || !fs.existsSync(root)) return null
  if (data.length > MAX_ATTACHMENT_BYTES) return null
  const safe = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment'
  const dir = path.join(root, '.farol', 'attachments')
  try {
    fs.mkdirSync(dir, { recursive: true })
    ensureAttachmentsIgnored(root)
    pruneOldAttachments(dir)
    const file = path.join(dir, `${randomUUID()}-${safe}`)
    fs.writeFileSync(file, data)
    return file
  } catch {
    return null
  }
}

function fail(error: string, conflict = false): ProjectFsResult<never> {
  return conflict ? { ok: false, error, conflict: true } : { ok: false, error }
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export { normalizeRelPath }

function resolveInside(root: string, rel: string): string | null {
  if (typeof root !== 'string' || !root) return null
  const relNorm = normalizeRelPath(rel)
  if (relNorm === null) return null
  const rootAbs = path.resolve(root)
  if (!fs.existsSync(rootAbs)) return null
  const target = relNorm ? path.resolve(rootAbs, relNorm) : rootAbs
  if (!inside(rootAbs, target) || !fs.existsSync(target)) return null
  try {
    const realRoot = fs.realpathSync(rootAbs)
    const realTarget = fs.realpathSync(target)
    return inside(realRoot, realTarget) ? realTarget : null
  } catch {
    return null
  }
}

function isUtf8Text(buf: Buffer): boolean {
  if (buf.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

function lineEndingOf(raw: string): ProjectLineEnding {
  return raw.includes('\r\n') ? 'crlf' : 'lf'
}

interface OpenedFile {
  lineEnding: ProjectLineEnding
  mtimeMs: number
}

const opened = new Map<string, OpenedFile>()

function openedKey(root: string, rel: string): string {
  return `${path.resolve(root)}\0${rel}`
}

function readDirents(dir: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
}

function toEntry(entry: fs.Dirent, relNorm: string): ProjectDirEntry | null {
  let kind: ProjectDirEntry['kind'] | null = null
  if (entry.isDirectory()) kind = 'dir'
  else if (entry.isFile()) kind = 'file'
  if (!kind) return null
  if (kind === 'dir' && SKIP.has(entry.name)) return null
  const child = relNorm ? `${relNorm}/${entry.name}` : entry.name
  return { name: entry.name, path: child, kind }
}

function compareEntries(a: ProjectDirEntry, b: ProjectDirEntry): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  return a.name.localeCompare(b.name)
}

export function listProjectDir(root: string, relDir = ''): ProjectFsResult<{ entries: ProjectDirEntry[] }> {
  const dir = resolveInside(root, relDir)
  if (!dir) return fail('Path is outside the project.')
  let stat: fs.Stats
  try {
    stat = fs.statSync(dir)
  } catch {
    return fail('Directory not found.')
  }
  if (!stat.isDirectory()) return fail('Not a directory.')
  const dirents = readDirents(dir)
  if (!dirents) return fail('Directory not found.')
  const relNorm = normalizeRelPath(relDir) ?? ''
  const entries: ProjectDirEntry[] = []
  for (const entry of dirents) {
    const item = toEntry(entry, relNorm)
    if (item) entries.push(item)
  }
  entries.sort(compareEntries)
  return { ok: true, entries }
}

export function readProjectFile(root: string, relPath: string): ProjectFsResult<ProjectFileRead> {
  const rel = normalizeRelPath(relPath)
  if (rel === null || rel === '') return fail('Path is outside the project.')
  const full = resolveInside(root, rel)
  if (!full) return fail('Path is outside the project.')
  let stat: fs.Stats
  try {
    stat = fs.statSync(full)
  } catch {
    return fail('File not found.')
  }
  if (!stat.isFile()) return fail('Not a file.')
  if (stat.size > MAX_PROJECT_FILE_BYTES) return fail('File is larger than 2MB.')
  let buf: Buffer
  try {
    buf = fs.readFileSync(full)
  } catch {
    return fail('File not found.')
  }
  if (!isUtf8Text(buf)) return fail(BINARY_ERROR)
  const raw = buf.toString('utf8')
  const lineEnding = lineEndingOf(raw)
  const content = raw.replace(/\r\n/g, '\n')
  opened.set(openedKey(root, rel), { lineEnding, mtimeMs: stat.mtimeMs })
  return { ok: true, path: rel, content, mtimeMs: stat.mtimeMs, lineEnding }
}

export function writeProjectFile(
  root: string,
  relPath: string,
  content: string,
  opts: ProjectWriteOpts = {}
): ProjectFsResult<ProjectFileWrite> {
  const rel = normalizeRelPath(relPath)
  if (rel === null || rel === '') return fail('Path is outside the project.')
  if (typeof content !== 'string' || content.includes('\0')) return fail(BINARY_ERROR)
  const prior = opened.get(openedKey(root, rel))
  if (!prior) return fail('File has not been opened.')
  if (Buffer.byteLength(content, 'utf8') > MAX_PROJECT_FILE_BYTES) return fail('File is larger than 2MB.')
  const full = resolveInside(root, rel)
  if (!full) return fail('Path is outside the project.')
  let stat: fs.Stats
  try {
    stat = fs.statSync(full)
  } catch {
    return fail('File not found.')
  }
  if (!stat.isFile()) return fail('Not a file.')
  const expected = opts.expectedMtimeMs ?? prior.mtimeMs
  if (!opts.overwrite && Math.abs(stat.mtimeMs - expected) > 1) {
    return fail('File changed on disk.', true)
  }
  const body = prior.lineEnding === 'crlf' ? content.replace(/\n/g, '\r\n') : content
  try {
    fs.writeFileSync(full, body, 'utf8')
    const next = fs.statSync(full)
    opened.set(openedKey(root, rel), { lineEnding: prior.lineEnding, mtimeMs: next.mtimeMs })
    return { ok: true, mtimeMs: next.mtimeMs }
  } catch {
    return fail('Could not write file.')
  }
}
