import { describe, expect, it } from 'vitest'
import { normalizeRelPath } from '@shared/rel-path'
import { detectIndent, fileName, isDirty, languageFromPath } from './code'

describe('languageFromPath', () => {
  it('maps known extensions and falls back to text', () => {
    expect(languageFromPath('src/App.tsx')).toBe('typescript')
    expect(languageFromPath('lib/index.js')).toBe('javascript')
    expect(languageFromPath('package.json')).toBe('json')
    expect(languageFromPath('styles.css')).toBe('css')
    expect(languageFromPath('index.html')).toBe('html')
    expect(languageFromPath('README.md')).toBe('markdown')
    expect(languageFromPath('main.py')).toBe('python')
    expect(languageFromPath('Makefile')).toBe('text')
    expect(languageFromPath('.env')).toBe('text')
  })
})

describe('detectIndent', () => {
  it('defaults to two spaces and follows the file when it can', () => {
    expect(detectIndent('alpha\nbeta\n')).toBe('  ')
    expect(detectIndent('function x() {\n\treturn 1\n}\n')).toBe('\t')
    expect(detectIndent('{\n    "a": 1\n}\n')).toBe('    ')
    expect(detectIndent('if (x) {\n  return 1\n}\n')).toBe('  ')
  })
})

describe('file helpers', () => {
  it('names a path, tracks dirty, and rejects escapes', () => {
    expect(fileName('src/components/CodePane.tsx')).toBe('CodePane.tsx')
    expect(isDirty('a', 'a')).toBe(false)
    expect(isDirty('a', 'b')).toBe(true)
    expect(normalizeRelPath('src/../secret')).toBeNull()
    expect(normalizeRelPath('src/code.ts')).toBe('src/code.ts')
  })
})
