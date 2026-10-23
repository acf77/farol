import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { listAgentSkills } from './skills'

const dirs: string[] = []

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-skills-'))
  dirs.push(dir)
  return dir
}

function writeSkill(root: string, rel: string, name: string, extra = ''): void {
  const dir = path.join(root, ...rel.split('/'), name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n${extra}---\nbody\n`)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('listAgentSkills', () => {
  it('lists user-invocable skills from every native root and prefers project', () => {
    const cwd = tmp()
    const home = tmp()
    writeSkill(home, '.claude/skills', 'personal')
    writeSkill(home, '.claude/skills', 'shared')
    writeSkill(cwd, '.claude/skills', 'shared')
    writeSkill(cwd, '.claude/skills', 'hidden', 'user-invocable: false\n')
    writeSkill(cwd, '.cursor/skills', 'cursor-only')

    expect(listAgentSkills(cwd, 'claude', home)).toEqual([
      { name: 'personal', token: '/personal' },
      { name: 'shared', token: '/shared' }
    ])
    expect(listAgentSkills(cwd, 'cursor', home).map((s) => s.name)).toEqual([
      'cursor-only',
      'personal',
      'shared'
    ])
  })

  it('lists Claude skills from .agents/skills, with .claude winning a name clash', () => {
    const cwd = tmp()
    const home = tmp()
    writeSkill(home, '.agents/skills', 'grill-me')
    writeSkill(home, '.agents/skills', 'shared')
    writeSkill(home, '.claude/skills', 'shared')

    expect(listAgentSkills(cwd, 'claude', home).map((s) => s.name)).toEqual(['grill-me', 'shared'])
  })

  it('follows symlinked skill folders and ignores broken links', () => {
    const cwd = tmp()
    const home = tmp()
    const store = tmp()
    writeSkill(store, '.', 'linked')
    const root = path.join(home, '.claude', 'skills')
    fs.mkdirSync(root, { recursive: true })
    fs.symlinkSync(path.join(store, 'linked'), path.join(root, 'linked'))
    fs.symlinkSync(path.join(store, 'missing'), path.join(root, 'broken'))

    expect(listAgentSkills(cwd, 'claude', home)).toEqual([{ name: 'linked', token: '/linked' }])
  })

  it('uses Codex $ tokens and OpenCode slash:false', () => {
    const cwd = tmp()
    const home = tmp()
    writeSkill(cwd, '.agents/skills', 'review')
    writeSkill(cwd, '.opencode/skills', 'quiet', 'slash: false\n')
    writeSkill(cwd, '.opencode/skills/shipping', 'land-it')

    expect(listAgentSkills(cwd, 'codex', home)).toEqual([{ name: 'review', token: '$review' }])
    expect(listAgentSkills(cwd, 'opencode', home)).toEqual([
      { name: 'land-it', token: '/land-it' },
      { name: 'review', token: '/review' }
    ])
  })
})
