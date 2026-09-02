import { isShellToolName } from './catalog-shell'
import type { Pipeline } from './types'

export function mandatoryPipelines(pipelines: Pipeline[]): Pipeline[] {
  return pipelines.filter((pipeline) => pipeline.mandatory === true)
}

/** Union agent-selected pipelines with every mandatory one (mandatory first). */
export function mergeWithMandatory(available: Pipeline[], selected: Pipeline[]): Pipeline[] {
  const mandatory = mandatoryPipelines(available)
  const seen = new Set(mandatory.map((pipeline) => pipeline.id))
  return [...mandatory, ...selected.filter((pipeline) => !seen.has(pipeline.id))]
}

/** Tool names that mean the agent may have changed project files. */
export function isCodeChangeToolName(name: string): boolean {
  if (isShellToolName(name)) return true
  const n = name.toLowerCase().replace(/[_-]/g, '')
  return (
    n === 'write' ||
    n === 'edit' ||
    n === 'strreplace' ||
    n === 'searchreplace' ||
    n === 'applypatch' ||
    n === 'delete' ||
    n === 'editnotebook' ||
    n === 'creategoal' ||
    n === 'updategoal'
  )
}

/** Empty FAROL_PIPELINES is invalid after a code change when mandatory pipelines exist. */
export function mandatoryOptOutError(
  available: Pipeline[],
  selected: Pipeline[],
  codeChanged: boolean
): string | undefined {
  if (selected.length || !codeChanged) return undefined
  const ids = mandatoryPipelines(available).map((pipeline) => pipeline.id)
  if (!ids.length) return undefined
  return (
    `Mandatory pipeline(s) must run when you change code: ${ids.join(', ')}. ` +
    `Select them via FAROL_PIPELINES: ${JSON.stringify(ids)} (you may add other pipelines too) ` +
    `and let Farol execute them — or use FAROL_PIPELINES: [] only when you made no code changes.`
  )
}
