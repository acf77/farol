import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

export function makeTempGitRepo(prefix: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo })
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const name = "Widget"\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  return repo
}