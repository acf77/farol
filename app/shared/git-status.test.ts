import { describe, expect, it } from 'vitest'
import {
  commitBlockReason,
  committableFiles,
  conflictMergeBase,
  conflictResolvePrompt,
  conflictSignals,
  conflictStatusItems,
  draftMatchesStatus,
  isSecretPath,
  parseAheadBehind,
  parseGitStatus,
  parseMergeTreeConflictPaths,
  pickPushRemote,
  pullRequestBlockReason,
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
    upstream: true,
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

describe('pickPushRemote', () => {
  it('prefers origin, else the first remote', () => {
    expect(pickPushRemote('upstream\norigin\nfork')).toBe('origin')
    expect(pickPushRemote('upstream\nfork')).toBe('upstream')
    expect(pickPushRemote('')).toBeUndefined()
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

  it('allows publishing a branch that has no upstream yet', () => {
    expect(pushBlockReason(status({ upstream: false, ahead: 2, remote: 'origin' }))).toBeNull()
  })

  it('blocks a branch with no remote, and an unpublished branch with nothing new', () => {
    expect(pushBlockReason(status({ upstream: false, ahead: 2 }))).toMatch(/remote/)
    expect(pushBlockReason(status({ upstream: false, ahead: 0, remote: 'origin' }))).toMatch(
      /unpublished/
    )
  })
})

describe('pullRequestBlockReason', () => {
  it('blocks conflicts, an unpushed branch, and unpushed commits', () => {
    expect(
      pullRequestBlockReason(
        status({ conflicts: [{ path: 'both.ts', kind: 'conflict', staged: false }] })
      )
    ).toMatch(/conflicts/)
    expect(pullRequestBlockReason(status({ upstream: false }))).toMatch(/Push this branch/)
    expect(pullRequestBlockReason(status({ ahead: 2 }))).toMatch(/latest commits/)
    expect(pullRequestBlockReason(null)).toMatch(/Reading/)
  })

  it('allows a pushed branch, even with local edits', () => {
    expect(
      pullRequestBlockReason(
        status({ unstaged: [{ path: 'src/a.ts', kind: 'modified', staged: false }] })
      )
    ).toBeNull()
  })
})

describe('conflictSignals', () => {
  it('flags working-tree, staging, and current-branch PR conflicts', () => {
    expect(
      conflictSignals(
        status({
          conflicts: [{ path: 'both.ts', kind: 'conflict', staged: false }],
          baseMerge: { base: 'staging', conflicts: true }
        }),
        {
          available: true,
          prs: [
            {
              number: 12,
              hasConflicts: true
            }
          ]
        }
      )
    ).toMatchObject({ workingTree: true, prConflicts: true, any: true })
  })

  it('ignores GitHub when no PR is open on this branch', () => {
    expect(conflictSignals(status({ clean: true }), { available: true, prs: [] })).toMatchObject({
      any: false,
      prConflicts: false
    })
  })
})

describe('conflictMergeBase', () => {
  it('uses the pull request base when GitHub reported conflicts', () => {
    expect(
      conflictMergeBase(status({ clean: true, baseMerge: { base: 'staging', conflicts: true } }), {
        available: true,
        prs: [{ number: 4, hasConflicts: true, base: 'main' }]
      })
    ).toBe('main')
  })

  it('uses staging when the pull request itself is clean', () => {
    expect(
      conflictMergeBase(status({ clean: true, baseMerge: { base: 'staging', conflicts: true } }), {
        available: true,
        prs: [{ number: 4, hasConflicts: false, base: 'main' }]
      })
    ).toBe('staging')
  })
})

describe('conflictStatusItems', () => {
  it('reports a clean staging merge and no PR', () => {
    expect(
      conflictStatusItems(status({ clean: true, baseMerge: { base: 'staging', conflicts: false } }), {
        available: true,
        prs: []
      })
    ).toEqual([
      { tone: 'ok', text: 'No conflicts with staging.' },
      { tone: 'muted', text: 'No open pull request from this branch.' }
    ])
  })

  it('reports an open PR conflict without listing other PRs', () => {
    expect(
      conflictStatusItems(status({ clean: true }), {
        available: true,
        prs: [
          {
            number: 4,
            hasConflicts: true
          }
        ]
      })
    ).toEqual([{ tone: 'conflict', text: 'Pull request #4 has merge conflicts.' }])
  })

  it('names the PR base when GitHub reported it', () => {
    expect(
      conflictStatusItems(status({ clean: true }), {
        available: true,
        prs: [{ number: 4, hasConflicts: true, base: 'main' }]
      })
    ).toEqual([{ tone: 'conflict', text: 'Pull request #4 has merge conflicts with main.' }])
  })
})

describe('parseMergeTreeConflictPaths', () => {
  it('reads CONFLICT lines from merge-tree output', () => {
    expect(
      parseMergeTreeConflictPaths(
        'CONFLICT (content): Merge conflict in src/a.ts\nchanged in both src/b.ts\n'
      )
    ).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('skips the tree oid and stage lines from --write-tree', () => {
    expect(
      parseMergeTreeConflictPaths(`84443a905c2e513c03e76dd19f09f0946b3c9202
100644 df967b96a579e45a18b8251732d16804b2e56a55 1	file.txt
100644 dcd5906e303dd0cffa818f7cebc4de7135496d7e 2	file.txt
100644 a7453f07505c42ea8d6fdda75fa91710c81c53d6 3	file.txt

Auto-merging file.txt
CONFLICT (content): Merge conflict in file.txt
`)
    ).toEqual(['file.txt'])
  })
})

describe('conflictResolvePrompt', () => {
  it('asks the agent to edit markers already in the tree', () => {
    const text = conflictResolvePrompt({
      pr: 7,
      base: 'staging',
      files: ['src/a.ts']
    })
    expect(text).toMatch(/Pull request #7/)
    expect(text).toMatch(/staging/)
    expect(text).toMatch(/src\/a\.ts/)
    expect(text).toMatch(/working tree/)
  })
})
