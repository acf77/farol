import { describe, expect, it } from 'vitest'
import { githubCredentialLines } from './git-credential'

describe('githubCredentialLines', () => {
  it('returns credentials only for github.com', () => {
    expect(githubCredentialLines('github.com', 'ghp_test', 'https')).toContain('password=ghp_test\n')
  })

  it('answers nothing for another host or a missing token', () => {
    expect(githubCredentialLines('example.com', 'ghp_test')).toBeUndefined()
    expect(githubCredentialLines('github.com', null)).toBeUndefined()
  })
})