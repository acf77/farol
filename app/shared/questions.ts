/**
 * Structured questions the managed agent can ask mid-chat.
 *
 * OpenCode's `question` tool (and Claude's AskUserQuestion) block the session
 * until the user picks options. Farol's headless CLIs ignore stdin, so the
 * same schema is delivered as `FAROL_QUESTIONS:` — or extracted from a
 * question tool_use in the NDJSON stream — and Farol shows the UI itself.
 */

import { CONTROL_MARKERS, FINISHED_PLAN, QUESTIONS_MARKER, lastControlLine, lastNonEmptyLine } from './control-line'

export {
  BLOCK_MARKER,
  CONTROL_MARKERS,
  FINISHED_PLAN,
  PIPELINES_MARKER,
  PLAN_MARKER,
  QUESTIONS_MARKER
} from './control-line'

/** Only the exact final control line makes a response executable. */
export function isFinishedPlan(text: string): boolean {
  const last = lastNonEmptyLine(text)
  return last?.fenced === false && last.line.trim() === FINISHED_PLAN
}

/** Drop the trailing marker line so the plan body can be replayed to the agent. */
export function stripFinishedPlan(text: string): string {
  if (!isFinishedPlan(text)) return text
  const lines = text.trimEnd().split(/\r?\n/)
  if (lines.at(-1)?.trim() === FINISHED_PLAN) lines.pop()
  return lines.join('\n').trimEnd()
}

export function hasControlMarker(text: string): boolean {
  return CONTROL_MARKERS.some((marker) => text.includes(marker))
}

export interface FinishedPlan {
  finished: true
  consumed?: true
}

/** Trust nothing: both the IPC boundary and the persisted-session boundary funnel through here. */
export function sanitizePlan(raw: unknown): FinishedPlan | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const plan = raw as Record<string, unknown>
  if (plan.finished !== true) return undefined
  return { finished: true, ...(plan.consumed === true ? { consumed: true } : {}) }
}

export interface QuestionOption {
  /** 1–5 words, shown as the choice. */
  label: string
  /** What picking this option means. */
  description: string
}

export interface AgentQuestion {
  question: string
  /** Short label for the card header (max 30 chars). */
  header: string
  options: QuestionOption[]
  multiple?: boolean
  /** Absent means true — a free-text answer is offered automatically. */
  custom?: boolean
}

const MAX_QUESTIONS = 8
const MAX_OPTIONS = 12
const MAX_HEADER = 30

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function isQuestionToolName(name: string): boolean {
  const id = name.toLowerCase().replace(/[_-]/g, '')
  return id === 'question' || id === 'askuserquestion'
}

function optionFrom(value: unknown): QuestionOption | undefined {
  if (typeof value === 'string') {
    const label = value.trim()
    return label ? { label, description: '' } : undefined
  }
  if (!isRecord(value) || typeof value.label !== 'string') return undefined
  const label = value.label.trim()
  if (!label) return undefined
  const description = typeof value.description === 'string' ? value.description.trim() : ''
  return { label, description }
}

function questionFrom(value: unknown): AgentQuestion | undefined {
  if (!isRecord(value) || typeof value.question !== 'string') return undefined
  const question = value.question.trim()
  if (!question) return undefined
  const rawOptions = Array.isArray(value.options) ? value.options : []
  const options = rawOptions.map(optionFrom).filter((o): o is QuestionOption => !!o)
  if (!options.length || options.length > MAX_OPTIONS) return undefined
  const headerRaw = typeof value.header === 'string' ? value.header.trim() : ''
  const multiple = value.multiple === true || value.multiSelect === true
  const custom = value.custom !== false
  return {
    question,
    header: clip(headerRaw || question, MAX_HEADER),
    options,
    ...(multiple ? { multiple: true } : {}),
    ...(custom ? {} : { custom: false })
  }
}

/** Normalize a JSON array (or `{ questions }`) into the OpenCode-shaped list. */
export function normalizeQuestions(value: unknown): { questions: AgentQuestion[] } | { error: string } {
  const raw = isRecord(value) && Array.isArray(value.questions) ? value.questions : value
  if (!Array.isArray(raw)) return { error: `The value after ${QUESTIONS_MARKER} must be a JSON array.` }
  if (!raw.length) return { error: 'Ask at least one question.' }
  if (raw.length > MAX_QUESTIONS) return { error: `Ask at most ${MAX_QUESTIONS} questions at a time.` }
  const questions: AgentQuestion[] = []
  for (const item of raw) {
    const question = questionFrom(item)
    if (!question) {
      return {
        error:
          'Each question needs a question string and 1–12 options with a non-empty label.'
      }
    }
    questions.push(question)
  }
  return { questions }
}

/**
 * `null` when the turn did not ask; otherwise questions or a parse error.
 * Accepts a single JSON line after the marker (same rule as FAROL_PIPELINES).
 */
export function parseQuestionsMarker(
  output: string
): { questions: AgentQuestion[] } | { error: string } | null {
  const raw = lastControlLine(output, QUESTIONS_MARKER)
  if (raw === undefined) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { error: `The value after ${QUESTIONS_MARKER} must be a JSON array.` }
  }
  return normalizeQuestions(value)
}

/** Pull questions out of a `question` / AskUserQuestion tool_use input. */
export function questionsFromToolInput(input: unknown): AgentQuestion[] | undefined {
  const parsed = normalizeQuestions(input)
  return 'questions' in parsed ? parsed.questions : undefined
}

function pickedLabels(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) return null
  return raw.map((item) => item.trim()).filter(Boolean)
}

function unknownLabel(question: AgentQuestion, picked: string[]): string | undefined {
  if (question.custom !== false) return undefined
  const labels = new Set(question.options.map((option) => option.label))
  return picked.find((label) => !labels.has(label))
}

function validateOne(
  question: AgentQuestion,
  raw: unknown,
  n: number
): string[] | { error: string } {
  const picked = pickedLabels(raw)
  if (!picked) return { error: `Question ${n} needs an array of selected labels.` }
  if (!picked.length) return { error: `Question ${n} needs an answer.` }
  if (!question.multiple && picked.length > 1) {
    return { error: `Question ${n} allows only one choice.` }
  }
  const bad = unknownLabel(question, picked)
  if (bad) return { error: `Question ${n} has no option labelled ${bad}.` }
  return [...new Set(picked)]
}

export function validateAnswers(
  questions: AgentQuestion[],
  answers: unknown
): { answers: string[][] } | { error: string } {
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    return { error: 'Answer every question, in order.' }
  }
  const out: string[][] = []
  for (let i = 0; i < questions.length; i++) {
    const result = validateOne(questions[i], answers[i], i + 1)
    if ('error' in result) return result
    out.push(result)
  }
  return { answers: out }
}

/** Prompt text the next agent turn sees — same idea as OpenCode's tool result. */
export function formatAnswers(questions: AgentQuestion[], answers: string[][] | null): string {
  if (!answers) {
    return 'The user dismissed the questions. Continue with your best judgment.'
  }
  const pairs = questions
    .map((question, i) => {
      const picked = answers[i]?.filter(Boolean) ?? []
      return `"${question.question}"="${picked.length ? picked.join(', ') : 'Unanswered'}"`
    })
    .join(', ')
  return `User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.`
}
