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
