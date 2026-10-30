export const REPO_URL = 'https://github.com/acf77/farol'

/** Issue form templates in `.github/ISSUE_TEMPLATE/`. */
export type FeedbackTemplate = 'feedback.yml' | 'bug.yml' | 'idea.yml'

export interface FeedbackEnv {
  appVersion: string
  osVersion: string
  arch: string
}

/** One line a maintainer can read at a glance, e.g. `Farol 0.5.3 · macOS 15.1.0 · arm64`. */
export function environmentLine(env: FeedbackEnv): string {
  return `Farol ${env.appVersion} · macOS ${env.osVersion} · ${env.arch}`
}

/**
 * A "new issue" link that opens the given form with its `environment` field
 * filled in, so a report always says which build and system it came from.
 */
export function feedbackIssueUrl(template: FeedbackTemplate, env: FeedbackEnv): string {
  const url = new URL(`${REPO_URL}/issues/new`)
  url.searchParams.set('template', template)
  url.searchParams.set('environment', environmentLine(env))
  return url.toString()
}
