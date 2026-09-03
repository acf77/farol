import { describe, expect, it } from 'vitest'
import {
  convertSkillDraft,
  effectiveSkills,
  filterSkills,
  insertSkillText,
  isUserInvocable,
  parseSkillFrontmatter,
  retainSkillWarning,
  skillMenuQuery,
  skillToken,
  skillWarningLine
} from './skills'

describe('skillToken', () => {
  it('uses each provider’s native prefix', () => {
    expect(skillToken('claude', 'grill-me')).toBe('/grill-me')
    expect(skillToken('cursor', 'grill-me')).toBe('/grill-me')
    expect(skillToken('opencode', 'grill-me')).toBe('/grill-me')
    expect(skillToken('codex', 'grill-me')).toBe('$grill-me')
  })
})

describe('parseSkillFrontmatter / isUserInvocable', () => {
  it('defaults to invocable and honors hide flags', () => {
    expect(isUserInvocable(parseSkillFrontmatter('# no frontmatter'))).toBe(true)
    expect(
      isUserInvocable(
        parseSkillFrontmatter('---\nname: x\nuser-invocable: false\n---\nbody')
      )
    ).toBe(false)
    expect(isUserInvocable(parseSkillFrontmatter('---\nslash: false\n---\n'))).toBe(false)
    expect(
      isUserInvocable(parseSkillFrontmatter('---\ndisable-model-invocation: true\n---\n'))
    ).toBe(true)
  })
})

describe('effectiveSkills', () => {
  it('keeps the highest-rank copy of a name', () => {
    expect(
      effectiveSkills([
        { name: 'review', token: '/review', rank: 1 },
        { name: 'review', token: '/review', rank: 10 },
        { name: 'audit', token: '/audit', rank: 1 }
      ])
    ).toEqual([
      { name: 'audit', token: '/audit' },
      { name: 'review', token: '/review' }
    ])
  })
})

describe('skillMenuQuery', () => {
  it('opens only for a leading / token', () => {
    expect(skillMenuQuery('/', 1)).toBe('')
    expect(skillMenuQuery('/gri', 4)).toBe('gri')
    expect(skillMenuQuery('/grill-me more', 4)).toBeNull()
    expect(skillMenuQuery('please /gri', 11)).toBeNull()
    expect(skillMenuQuery('/gri\nmore', 3)).toBe('gri')
    expect(skillMenuQuery('/gri\nmore', 6)).toBeNull()
    expect(skillMenuQuery('/gri', 0)).toBeNull()
  })
})

describe('insertSkillText / convertSkillDraft', () => {
  it('replaces the leading / query with the native token', () => {
    expect(insertSkillText('/gri', '$grill-me')).toEqual({
      text: '$grill-me ',
      caret: 10
    })
    expect(insertSkillText('/gri leftover', '/grill-me')).toEqual({
      text: '/grill-me leftover',
      caret: 10
    })
  })

  it('rewrites a known skill and keeps an unavailable one', () => {
    expect(
      convertSkillDraft('/grill-me please', 'codex', new Set(['grill-me']), new Set(['grill-me']))
    ).toEqual({ text: '$grill-me please', unavailable: [] })
    expect(
      convertSkillDraft('$missing please', 'claude', new Set(), new Set(['missing']))
    ).toEqual({ text: '$missing please', unavailable: ['missing'] })
    expect(
      convertSkillDraft('/not-a-skill', 'codex', new Set(), new Set())
    ).toEqual({ text: '/not-a-skill', unavailable: [] })
  })
})

describe('filterSkills / warning', () => {
  const skills = [
    { name: 'grill-me', token: '/grill-me' },
    { name: 'review', token: '/review' }
  ]

  it('filters by name substring', () => {
    expect(filterSkills(skills, 'gri')).toEqual([skills[0]])
    expect(filterSkills(skills, '')).toEqual(skills)
  })

  it('keeps a warning only while the token is still in the draft', () => {
    expect(retainSkillWarning('/missing rest', ['missing'])).toEqual(['missing'])
    expect(retainSkillWarning('plain text', ['missing'])).toEqual([])
    expect(skillWarningLine(['missing'], 'codex')).toBe('missing is not available for Codex.')
    expect(skillWarningLine(['a', 'b'], 'claude')).toBe('a, b are not available for Claude.')
  })
})
