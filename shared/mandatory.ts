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

/** File-writing tools. These persist mandatory-outstanding across repair turns. */
export function isWriteToolName(name: string): boolean {
  const n = name.toLowerCase().replace(/[_-]/g, '')
  return (
    n === 'write' ||
    n === 'writefile' ||
    n === 'edit' ||
    n === 'editfile' ||
    n === 'multiedit' ||
    n === 'strreplace' ||
    n === 'searchreplace' ||
    n === 'applypatch' ||
    n === 'delete' ||
    n === 'deletefile' ||
    n === 'editnotebook' ||
    n === 'notebookedit'
  )
}

/** This-turn heuristic: write tools or any shell. Goal/read tools are not. */
export function isCodeChangeToolName(name: string): boolean {
  return isWriteToolName(name) || isShellToolName(name)
}

/** Empty FAROL_PIPELINES is invalid when mandatory pipelines still need to run. */
export function mandatoryOptOutError(
  available: Pipeline[],
  selected: Pipeline[],
  mustRun: boolean
): string | undefined {
  if (selected.length || !mustRun) return undefined
  const ids = mandatoryPipelines(available).map((pipeline) => pipeline.id)
  if (!ids.length) return undefined
  return (
    `Mandatory pipeline(s) must run after a code change and after a failed mandatory run until they pass: ${ids.join(', ')}. ` +
    `Select them via FAROL_PIPELINES: ${JSON.stringify(ids)} (you may add other pipelines too) ` +
    `and let Farol execute them — or use FAROL_PIPELINES: [] only when you made no code changes ` +
    `and no mandatory pipeline is still waiting to pass.`
  )
}
