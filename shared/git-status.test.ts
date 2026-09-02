import { describe, expect, it } from 'vitest'
import {
  commitBlockReason,
  committableFiles,
  draftMatchesStatus,
  isSecretPath,
  parseAheadBehind,
  parseGitStatus,
  pushBlockReason
} from './git-status'
import type { GitStatus } from './types'

function status(partial: Partial<GitStatus>): GitStatus {
  return {
    clean: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: [],
    ahead: 0,
    behind: 0,
    ...partial
  }
}

describe('parseGitStatus', () => {
  it('splits staged, unstaged, untracked, and conflicts', () => {
    const out = parseGitStatus(`M  staged.txt
 M unstaged.txt
?? new.txt
UU both.txt`)
    expect(out.staged.map((f) => f.path)).toEqual(['staged.txt'])
    expect(out.unstaged.map((f) => f.path)).toEqual(['unstaged.txt'])
    expect(out.untracked.map((f) => f.path)).toEqual(['new.txt'])
    expect(out.conflicts.map((f) => f.path)).toEqual(['both.txt'])
    expect(out.clean).toBe(false)
  })

  it('reports clean when porcelain is empty', () => {
    expect(parseGitStatus('').clean).toBe(true)
  })
})

describe('parseAheadBehind', () => {
  it('parses left-right counts', () => {
    expect(parseAheadBehind('2\t3')).toEqual({ behind: 2, ahead: 3 })
  })
})

describe('isSecretPath', () => {
  it('flags env, key, and credential files', () => {
    expect(isSecretPath('.env')).toBe(true)
    expect(isSecretPath('app/.env.local')).toBe(true)
    expect(isSecretPath('certs/prod.pem')).toBe(true)
    expect(isSecretPath('credentials.json')).toBe(true)
    expect(isSecretPath('id_ed25519')).toBe(true)
    expect(isSecretPath('.envrc')).toBe(true)
    expect(isSecretPath('secrets.json')).toBe(true)
    expect(isSecretPath('gcp/service-account.json')).toBe(true)
    expect(isSecretPath('prod.tfvars')).toBe(true)
  })

  it('leaves ordinary and example env files alone', () => {
    expect(isSecretPath('src/app.ts')).toBe(false)
    expect(isSecretPath('.env.example')).toBe(false)
    expect(isSecretPath('.env.sample')).toBe(false)
  })
})

describe('committableFiles', () => {
  it('drops secret paths and keeps the rest', () => {
    const out = committableFiles(
      status({
        staged: [{ path: 'src/a.ts', kind: 'modified', staged: true }],
        untracked: [
          { path: '.env', kind: 'untracked', staged: false },
          { path: 'notes.md', kind: 'untracked', staged: false }
        ]
      })
    )
    expect(out.files).toEqual(['src/a.ts', 'notes.md'])
    expect(out.skipped).toEqual(['.env'])
  })
})

describe('draftMatchesStatus', () => {
  it('matches the committable set regardless of order', () => {
    const st = status({
      staged: [{ path: 'src/a.ts', kind: 'modified', staged: true }],
      untracked: [{ path: 'notes.md', kind: 'untracked', staged: false }]
    })
    expect(draftMatchesStatus(['notes.md', 'src/a.ts'], st)).toBe(true)
    expect(draftMatchesStatus(['src/a.ts'], st)).toBe(false)
    expect(draftMatchesStatus(['src/a.ts', 'notes.md', 'extra.ts'], st)).toBe(false)
  })
})

describe('commitBlockReason', () => {
  it('blocks conflicts, a clean tree, and secrets-only changes', () => {
    expect(
      commitBlockReason(
        status({
          conflicts: [{ path: 'both.ts', kind: 'conflict', staged: false }]
        })
      )
    ).toMatch(/conflicts/)
    expect(commitBlockReason(status({ clean: true }))).toMatch(/clean/)
    expect(
      commitBlockReason(
        status({
          untracked: [{ path: '.env', kind: 'untracked', staged: false }]
        })
      )
    ).toMatch(/secret/)
  })

  it('allows a dirty tree with committable files', () => {
    expect(
      commitBlockReason(
        status({
          unstaged: [{ path: 'src/a.ts', kind: 'modified', staged: false }]
        })
      )
    ).toBeNull()
  })
})

describe('pushBlockReason', () => {
  it('blocks conflicts, behind, and an even branch', () => {
    expect(
      pushBlockReason(
        status({
          conflicts: [{ path: 'both.ts', kind: 'conflict', staged: false }],
          ahead: 1
        })
      )
    ).toMatch(/conflicts/)
    expect(pushBlockReason(status({ ahead: 2, behind: 1 }))).toMatch(/behind/)
    expect(pushBlockReason(status({ ahead: 0 }))).toMatch(/even/)
  })

  it('allows push when ahead, even if the worktree is dirty', () => {
    expect(
      pushBlockReason(
        status({
          ahead: 2,
          unstaged: [{ path: 'src/a.ts', kind: 'modified', staged: false }]
        })
      )
    ).toBeNull()
  })
})
