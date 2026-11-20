import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { confineTo, confineToProjects, isInside } from './confine'

/** A real folder (no links in its own path) that holds the project and another repository beside it. */
let base: string
let project: string
let other: string

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-confine-')))
  project = path.join(base, 'project')
  other = path.join(base, 'other')
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.mkdirSync(path.join(other, 'deeper'), { recursive: true })
})

afterEach(() => fs.rmSync(base, { recursive: true, force: true }))

describe('confineTo', () => {
  it('accepts the project and the folders inside it, and returns where they really are', async () => {
    expect(await confineTo([project], project)).toEqual({ dir: project, checkout: project })
    expect(await confineTo([project], path.join(project, 'src'))).toEqual({
      dir: path.join(project, 'src'),
      checkout: project
    })
  })

  it('refuses a link inside the project that leads to another repository', async () => {
    fs.symlinkSync(other, path.join(project, 'link'))
    expect(await confineTo([project], path.join(project, 'link'))).toBeUndefined()
    expect(await confineTo([project], path.join(project, 'link', 'deeper'))).toBeUndefined()
  })

  it('accepts a link that stays inside the project, and names the folder it leads to', async () => {
    fs.symlinkSync(path.join(project, 'src'), path.join(project, 'alias'))
    expect(await confineTo([project], path.join(project, 'alias'))).toEqual({
      dir: path.join(project, 'src'),
      checkout: project
    })
  })

  it('accepts a project that is itself reached through a link, written either way', async () => {
    const shortcut = path.join(base, 'shortcut')
    fs.symlinkSync(project, shortcut)
    expect(await confineTo([shortcut], path.join(project, 'src'))).toEqual({
      dir: path.join(project, 'src'),
      checkout: shortcut
    })
    expect(await confineTo([project], path.join(shortcut, 'src'))).toEqual({
      dir: path.join(project, 'src'),
      checkout: project
    })
  })

  it('refuses a folder whose name only starts like the project\'s', async () => {
    const lookalike = path.join(base, 'project-evil')
    fs.mkdirSync(lookalike)
    expect(await confineTo([project], lookalike)).toBeUndefined()
  })

  it('refuses the parent, a sibling, a way out through `..`, and the root of the disk', async () => {
    expect(await confineTo([project], base)).toBeUndefined()
    expect(await confineTo([project], other)).toBeUndefined()
    expect(await confineTo([project], path.join(project, 'src', '..', '..', 'other'))).toBeUndefined()
    expect(await confineTo([project], path.parse(project).root)).toBeUndefined()
  })

  it('refuses a folder that does not exist and anything that is not a path', async () => {
    expect(await confineTo([project], path.join(project, 'missing'))).toBeUndefined()
    for (const value of [undefined, null, 42, '', {}, ['src']]) {
      expect(await confineTo([project], value)).toBeUndefined()
    }
  })

  it('tries every allowed folder, such as the linked worktrees of a project', async () => {
    const worktree = path.join(base, 'worktree')
    fs.mkdirSync(worktree)
    expect(await confineTo([project, worktree], worktree)).toEqual({ dir: worktree, checkout: worktree })
    expect(await confineTo([project, worktree], other)).toBeUndefined()
  })

  it('ignores an allowed folder that does not exist', async () => {
    expect(await confineTo([path.join(base, 'gone'), project], project)).toEqual({ dir: project, checkout: project })
    expect(await confineTo([path.join(base, 'gone')], project)).toBeUndefined()
  })
})

describe('confineToProjects', () => {
  it('finds the project that holds the folder, among several, and asks for no worktrees', async () => {
    const worktreesOf = vi.fn(async () => [])
    expect(await confineToProjects([other, project], worktreesOf, path.join(project, 'src'))).toEqual({
      dir: path.join(project, 'src'),
      checkout: project
    })
    expect(worktreesOf).not.toHaveBeenCalled()
  })

  it('finds a linked worktree of a project, which can sit outside the project', async () => {
    const worktree = path.join(base, 'worktree')
    fs.mkdirSync(worktree)
    const worktreesOf = async (p: string) => (p === project ? [worktree] : [])
    expect(await confineToProjects([other, project], worktreesOf, worktree)).toEqual({ dir: worktree, checkout: worktree })
  })

  it('refuses a repository that is not an open project, however its folder is reached', async () => {
    fs.symlinkSync(other, path.join(project, 'link'))
    const worktreesOf = async () => []
    expect(await confineToProjects([project], worktreesOf, other)).toBeUndefined()
    expect(await confineToProjects([project], worktreesOf, path.join(project, 'link'))).toBeUndefined()
    expect(await confineToProjects([], worktreesOf, project)).toBeUndefined()
  })
})

describe('isInside', () => {
  it('compares path segments, not text', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b/..cache')).toBe(true)
    expect(isInside('/', '/etc')).toBe(true)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a')).toBe(false)
    expect(isInside('/a/b', '/a/b/../c')).toBe(false)
  })
})
