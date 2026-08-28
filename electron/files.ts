/**
 * Lightweight project file listing for the composer @-picker and ⌘K palette.
 * Skips heavy / generated directories so the walk stays snappy on big repos.
 */

import fs from 'fs'
import path from 'path'

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
  '.buildflow',
  '.cursor',
  '.claude'
])

const MAX_FILES = 400
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])
/** Reject oversized drops before they cross IPC. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const ATTACHMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const ATTACHMENTS_IGNORE = '.buildflow/attachments/'

export function listProjectFiles(root: string, query = ''): string[] {
  if (typeof root !== 'string' || !root || !fs.existsSync(root)) return []
  const needle = query.trim().toLowerCase()
  const out: string[] = []

  const walk = (dir: string): void => {
    if (out.length >= MAX_FILES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const rel = path.relative(root, full).split(path.sep).join('/')
      if (needle && !rel.toLowerCase().includes(needle)) continue
      out.push(rel)
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

/** Save a dropped chat image under `.buildflow/attachments/` and return its absolute path. */
export function saveChatAttachment(root: string, name: string, data: Buffer): string | null {
  if (typeof root !== 'string' || !root || !fs.existsSync(root)) return null
  if (data.length > MAX_ATTACHMENT_BYTES) return null
  const ext = path.extname(name).toLowerCase()
  if (!IMAGE_EXT.has(ext)) return null
  const safe = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_') || `image${ext || '.png'}`
  const dir = path.join(root, '.buildflow', 'attachments')
  try {
    fs.mkdirSync(dir, { recursive: true })
    ensureAttachmentsIgnored(root)
    pruneOldAttachments(dir)
    const file = path.join(dir, `${Date.now()}-${safe}`)
    fs.writeFileSync(file, data)
    return file
  } catch {
    return null
  }
}
