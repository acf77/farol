import { describe, expect, it } from 'vitest'
import { gitArgs, gitArtifactPath, gitDeltaPath, gitNamesArgs, gitStepError, isDiffOp } from './git-step'

describe('gitStepError', () => {
  it('accepts a plain step', () => {
    expect(gitStepError({ op: 'diff', base: 'origin/main', paths: ['*.go', 'src/**/*.ts'] })).toBeNull()
    expect(gitStepError({ op: 'status' })).toBeNull()
  })

  it('needs a known op', () => {
    expect(gitStepError({})).toMatch(/op/)
    expect(gitStepError({ op: 'push' as never })).toMatch(/op/)
  })

  it.each(['main;rm -rf x', '$(id)', '`id`', 'a b', '-o/tmp/x', '--output=x', 'a..b', "m'ain", 'main|cat', ''.padEnd(201, 'a')])(
    'refuses base %j',
    (base) => {
      expect(gitStepError({ op: 'diff', base })).toMatch(/base/)
    }
  )

  it.each(['a;b', '$HOME', '../x', '-x', ':(top)x', 'a b', 'a\nb'])('refuses path %j', (path) => {
    expect(gitStepError({ op: 'diff', paths: [path] })).toMatch(/paths/)
  })

  it('limits the number of paths', () => {
    expect(gitStepError({ op: 'diff', paths: Array.from({ length: 33 }, (_, i) => `f${i}`) })).toMatch(/at most/)
  })
})

describe('gitArgs', () => {
  it('builds fixed arguments per op, with paths after `--`', () => {
    const base = ['--no-color', '--no-ext-diff', '--no-textconv']
    expect(gitArgs({ op: 'diff', base: 'main', paths: ['*.go'] })).toEqual(['diff', ...base, '--no-renames', 'main', '--', '*.go'])
    expect(gitArgs({ op: 'diff' })).toEqual(['diff', ...base, '--no-renames', 'HEAD', '--'])
    expect(gitArgs({ op: 'diff-stat', base: 'main' })).toEqual(['diff', ...base, '--stat', 'main', '--'])
    expect(gitArgs({ op: 'changed-files' })).toEqual(['diff', ...base, '--name-only', 'HEAD', '--'])
    expect(gitArgs({ op: 'log', base: 'main' })).toEqual(['log', '--no-color', '--oneline', '-n', '50', 'main..HEAD', '--'])
    expect(gitArgs({ op: 'status', paths: ['src'] })).toEqual(['status', '--short', '--branch', '--', 'src'])
  })

  it('leaves hidden paths out, literally, after the wanted paths', () => {
    expect(gitArgs({ op: 'diff', paths: ['*.go'] }, ['.env', 'a/id_rsa'])).toEqual([
      'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--', '*.go', ':(top,exclude,literal).env', ':(top,exclude,literal)a/id_rsa'
    ])
  })

  it('lists the files a diff reads, NUL-separated', () => {
    expect(gitNamesArgs({ op: 'diff', base: 'main', paths: ['*.go'] })).toEqual([
      'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', 'main', '--', '*.go'
    ])
  })

  it('compares the two trees of a range for the diff ops only', () => {
    const base = ['--no-color', '--no-ext-diff', '--no-textconv']
    const range = { from: 'abc123', to: 'def456' }
    expect(gitArgs({ op: 'diff', base: 'main', paths: ['*.go'] }, [], range)).toEqual(['diff', ...base, '--no-renames', 'abc123', 'def456', '--', '*.go'])
    expect(gitArgs({ op: 'diff-stat', base: 'main' }, [], range)).toEqual(['diff', ...base, '--stat', 'abc123', 'def456', '--'])
    expect(gitArgs({ op: 'changed-files' }, [], range)).toEqual(['diff', ...base, '--name-only', 'abc123', 'def456', '--'])
    expect(gitArgs({ op: 'log', base: 'main' }, [], range)).toEqual(['log', '--no-color', '--oneline', '-n', '50', 'main..HEAD', '--'])
    expect(gitArgs({ op: 'status' }, [], range)).toEqual(['status', '--short', '--branch', '--'])
    expect(gitNamesArgs({ op: 'diff', paths: ['*.go'] }, range)).toEqual([
      'diff', ...base, '--no-renames', '--name-only', '-z', 'abc123', 'def456', '--', '*.go'
    ])
  })

  it('knows which ops print a diff', () => {
    expect(['diff', 'diff-stat', 'changed-files', 'log', 'status', undefined].map((op) => isDiffOp(op as never))).toEqual([
      true, true, true, false, false, false
    ])
  })

  it('ignores empty paths from a half-typed list', () => {
    expect(gitArgs({ op: 'status', paths: ['', 'src', ''] })).toEqual(['status', '--short', '--branch', '--', 'src'])
  })
})

describe('gitArtifactPath', () => {
  it('names the file after the output name, else the node id', () => {
    expect(gitArtifactPath({ id: 'n1', op: 'diff', as: 'diff' }, 'p1')).toBe('.farol/git/p1/diff.patch')
    expect(gitArtifactPath({ id: 'n1', op: 'log' }, 'p1')).toBe('.farol/git/p1/n1.txt')
    expect(gitArtifactPath({ id: '../x/y', op: 'status' }, 'a/b')).toBe('.farol/git/a_2f_b/_2e__2e__2f_x_2f_y.txt')
    expect(gitArtifactPath({ id: 'n', op: 'log' }, 'a_b')).not.toBe(gitArtifactPath({ id: 'n', op: 'log' }, 'a/b'))
  })

  it('keeps a diff step\'s changes since the last run beside its result', () => {
    expect(gitDeltaPath({ id: 'n1', op: 'diff', as: 'diff' }, 'p1')).toBe('.farol/git/p1/diff.delta.patch')
    // A step named `diff.delta` escapes its dot, so it cannot take the delta's file.
    expect(gitArtifactPath({ id: 'n2', op: 'diff', as: 'diff.delta' }, 'p1')).not.toBe(gitDeltaPath({ id: 'n1', op: 'diff', as: 'diff' }, 'p1'))
  })
})
