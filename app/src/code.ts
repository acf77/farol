export type EditorLanguage =
  | 'javascript'
  | 'typescript'
  | 'json'
  | 'css'
  | 'html'
  | 'markdown'
  | 'python'
  | 'text'

const EXT: Record<string, EditorLanguage> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  json: 'json',
  css: 'css',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python'
}

export function languageFromPath(relPath: string): EditorLanguage {
  const base = relPath.split('/').pop() ?? relPath
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'text'
  return EXT[base.slice(dot + 1).toLowerCase()] ?? 'text'
}

export function fileName(relPath: string): string {
  return relPath.split('/').pop() || relPath
}

export function isDirty(original: string, current: string): boolean {
  return original !== current
}

/** Indent unit for the file. Tabs if they dominate; otherwise 2 spaces (4 when that is clearer). */
export function detectIndent(text: string): string {
  let tabs = 0
  const spaces: number[] = []
  for (const line of text.split('\n').slice(0, 80)) {
    if (line.startsWith('\t')) {
      tabs += 1
      continue
    }
    const match = /^ +/.exec(line)
    if (match) spaces.push(match[0].length)
  }
  if (tabs > spaces.length) return '\t'
  let twos = 0
  let fours = 0
  for (const n of spaces) {
    if (n % 4 === 0) fours += 1
    if (n % 2 === 0) twos += 1
  }
  if (fours > 0 && fours >= twos / 2 && fours >= spaces.length / 2) return '    '
  return '  '
}
