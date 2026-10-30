import { describe, expect, it } from 'vitest'
import { environmentLine, feedbackIssueUrl } from './feedback'

const env = { appVersion: '0.5.3', osVersion: '15.1.0', arch: 'arm64' }

describe('feedback links', () => {
  it('describes the build and system on one line', () => {
    expect(environmentLine(env)).toBe('Farol 0.5.3 · macOS 15.1.0 · arm64')
  })

  it('opens the chosen issue form with the environment filled in', () => {
    const url = new URL(feedbackIssueUrl('bug.yml', env))
    expect(url.origin + url.pathname).toBe('https://github.com/acf77/farol/issues/new')
    expect(url.searchParams.get('template')).toBe('bug.yml')
    expect(url.searchParams.get('environment')).toBe('Farol 0.5.3 · macOS 15.1.0 · arm64')
  })

  it('encodes characters that would otherwise break the query', () => {
    const url = feedbackIssueUrl('feedback.yml', { ...env, appVersion: '1.0.0-beta+1 &x=y' })
    expect(url).not.toContain('&x=y')
    expect(new URL(url).searchParams.get('environment')).toContain('1.0.0-beta+1 &x=y')
  })
})
