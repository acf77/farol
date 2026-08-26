import { describe, expect, it } from 'vitest'
import { groupOpenProjects } from './project-groups'
import type { GitInfo, Project } from './types'

const proj = (name: string, path: string): Project => ({
  name,
  path,
  display: `~/${name}`
})

const git = (branch: string, worktrees: { path: string; branch: string }[]): GitInfo => ({
  isRepo: true,
  branch,
  branches: [branch],
  worktrees
})

describe('groupOpenProjects', () => {
  it('nests same-repo worktrees under one group', () => {
    const main = proj('acme', '/src/acme')
    const feat = proj('acme-feat-x', '/src/acme-feat-x')
    const trees = [
      { path: '/src/acme', branch: 'main' },
      { path: '/src/acme-feat-x', branch: 'feat/x' }
    ]
    const groups = groupOpenProjects([main, feat], {
      [main.path]: git('main', trees),
      [feat.path]: git('feat/x', trees)
    })
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('acme')
    expect(groups[0].projects.map((p) => p.branch)).toEqual(['feat/x', 'main'])
  })

  it('keeps unrelated folders separate', () => {
    const a = proj('one', '/src/one')
    const b = proj('two', '/src/two')
    const groups = groupOpenProjects([a, b], {
      [a.path]: git('main', [{ path: '/src/one', branch: 'main' }]),
      [b.path]: git('main', [{ path: '/src/two', branch: 'main' }])
    })
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.label).sort()).toEqual(['one', 'two'])
  })

  it('treats non-git folders as their own group', () => {
    const a = proj('notes', '/src/notes')
    const groups = groupOpenProjects([a], {
      [a.path]: { isRepo: false, branch: '', branches: [] }
    })
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('notes')
    expect(groups[0].projects[0].branch).toBe('notes')
  })
})
