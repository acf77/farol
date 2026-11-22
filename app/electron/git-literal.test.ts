import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { captureTree } from './delegate-snapshot'
import { commitAll } from './git'

let cwd = ''
const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

afterEach(() => {
  if (cwd) fs.rmSync(cwd, { recursive: true, force: true })
})

it('commits a literal wildcard name without including other files', async () => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-git-literal-'))
  git('init')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  for (const file of ['*.ts', 'other.ts']) fs.writeFileSync(path.join(cwd, file), 'before\n')
  git('add', '--all')
  git('commit', '-m', 'initial')
  for (const file of ['*.ts', 'other.ts']) fs.writeFileSync(path.join(cwd, file), 'after\n')
  git('add', '--', 'other.ts')
  const tree = await captureTree(cwd)
  const branch = git('branch', '--show-current')

  expect(await commitAll(cwd, 'selected', ['*.ts'], { branch, tree })).toMatchObject({ ok: true })
  expect(git('show', '--format=', '--name-only', 'HEAD')).toBe('*.ts')
  expect(git('diff', '--name-only')).toBe('other.ts')
})

it('restores partial staging when a hook refuses a scoped commit', async () => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-git-index-'))
  git('init')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  for (const file of ['selected.txt', 'other.txt']) fs.writeFileSync(path.join(cwd, file), 'before\n')
  git('add', '--all')
  git('commit', '-m', 'initial')
  fs.writeFileSync(path.join(cwd, 'selected.txt'), 'selected\n')
  fs.writeFileSync(path.join(cwd, 'other.txt'), 'staged\n')
  git('add', 'other.txt')
  fs.writeFileSync(path.join(cwd, 'other.txt'), 'working\n')
  const staged = git('rev-parse', ':other.txt')
  const tree = await captureTree(cwd)
  const branch = git('branch', '--show-current')
  git('config', 'core.hooksPath', '.git/hooks')
  const hook = path.join(cwd, '.git', 'hooks', 'pre-commit')
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })

  expect(await commitAll(cwd, 'selected', ['selected.txt'], { branch, tree })).toMatchObject({ ok: false })
  expect(git('rev-parse', ':other.txt')).toBe(staged)
})
