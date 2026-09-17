import { describe, expect, it } from 'vitest'
import {
  QUESTIONS_MARKER,
  formatAnswers,
  isFinishedPlan,
  isQuestionToolName,
  normalizeQuestions,
  parseQuestionsMarker,
  questionsFromToolInput,
  stripFinishedPlan,
  validateAnswers
} from './questions'

const db = {
  question: 'Which database should we use?',
  header: 'Database',
  options: [
    { label: 'Postgres', description: 'Existing stack' },
    { label: 'SQLite', description: 'Local file' }
  ]
}

describe('normalizeQuestions', () => {
  it('accepts OpenCode-shaped questions and Claude multiSelect', () => {
    const parsed = normalizeQuestions({
      questions: [{ ...db, multiSelect: true, custom: false }]
    })
    expect(parsed).toEqual({
      questions: [{ ...db, multiple: true, custom: false }]
    })
  })

  it('defaults a missing header and treats custom as on', () => {
    const parsed = normalizeQuestions([
      { question: 'Ship it?', options: [{ label: 'Yes', description: '' }] }
    ])
    expect(parsed).toEqual({
      questions: [
        {
          question: 'Ship it?',
          header: 'Ship it?',
          options: [{ label: 'Yes', description: '' }]
        }
      ]
    })
  })

  it('rejects an empty list and a question with no options', () => {
    expect(normalizeQuestions([])).toEqual({ error: 'Ask at least one question.' })
    expect(normalizeQuestions([{ question: 'Hi?', options: [] }])).toMatchObject({
      error: expect.stringContaining('options')
    })
  })
})

describe('parseQuestionsMarker', () => {
  it('reads the last marker line and ignores earlier ones', () => {
    const first = `${QUESTIONS_MARKER} ${JSON.stringify([{ question: 'Old?', options: [{ label: 'A' }] }])}`
    const second = `${QUESTIONS_MARKER} ${JSON.stringify([db])}`
    expect(parseQuestionsMarker(`thinking\n${first}\n${second}\n`)).toEqual({
      questions: [db]
    })
  })

  it('returns null when the turn did not ask', () => {
    expect(parseQuestionsMarker('FAROL_PIPELINES: []\n')).toBeNull()
  })

  it('reports invalid JSON after the marker', () => {
    expect(parseQuestionsMarker(`${QUESTIONS_MARKER} not-json\n`)).toEqual({
      error: `The value after ${QUESTIONS_MARKER} must be a JSON array.`
    })
  })
})

describe('questionsFromToolInput', () => {
  it('reads AskUserQuestion / question tool input', () => {
    expect(questionsFromToolInput({ questions: [db] })).toEqual([db])
    expect(questionsFromToolInput({ command: 'ls' })).toBeUndefined()
  })
})

describe('isFinishedPlan', () => {
  it('accepts only the exact final Plan marker', () => {
    expect(isFinishedPlan('Ready.\nFAROL_PLAN: finished\n')).toBe(true)
    expect(isFinishedPlan('FAROL_PLAN: finished\nOne more thing')).toBe(false)
    expect(isFinishedPlan('FAROL_PLAN: draft')).toBe(false)
  })

  it('ignores a finished marker inside an unclosed fenced example', () => {
    expect(isFinishedPlan('Example:\n```\nFAROL_PLAN: finished')).toBe(false)
  })

  it('requires the finished marker to remain the final response line', () => {
    expect(isFinishedPlan('FAROL_PLAN: finished\n```\nconst plan = true')).toBe(false)
  })
})

describe('stripFinishedPlan', () => {
  it('drops the trailing marker line so the plan body can be replayed', () => {
    expect(stripFinishedPlan('Step 1: do X\nStep 2: do Y\nFAROL_PLAN: finished')).toBe(
      'Step 1: do X\nStep 2: do Y'
    )
  })

  it('leaves text unchanged when there is no marker to strip', () => {
    expect(stripFinishedPlan('Just some text')).toBe('Just some text')
  })

  it('does not strip a finished marker followed by fenced content', () => {
    const text = 'FAROL_PLAN: finished\n```\nconst plan = true'
    expect(stripFinishedPlan(text)).toBe(text)
  })
})

describe('isQuestionToolName', () => {
  it('matches OpenCode and Claude names', () => {
    expect(isQuestionToolName('question')).toBe(true)
    expect(isQuestionToolName('AskUserQuestion')).toBe(true)
    expect(isQuestionToolName('ask_user_question')).toBe(true)
    expect(isQuestionToolName('Bash')).toBe(false)
  })
})

describe('validateAnswers / formatAnswers', () => {
  it('accepts one label, or a custom string when custom is on', () => {
    expect(validateAnswers([db], [['Postgres']])).toEqual({ answers: [['Postgres']] })
    expect(validateAnswers([db], [['Cockroach']])).toEqual({ answers: [['Cockroach']] })
    expect(validateAnswers([{ ...db, custom: false }], [['Cockroach']])).toMatchObject({
      error: expect.stringContaining('Cockroach')
    })
  })

  it('rejects a missing answer and extra picks on a single-choice question', () => {
    expect(validateAnswers([db], [[]])).toMatchObject({ error: expect.stringContaining('needs an answer') })
    expect(validateAnswers([db], [['Postgres', 'SQLite']])).toMatchObject({
      error: expect.stringContaining('only one')
    })
  })

  it('formats picks the way OpenCode returns them to the model', () => {
    expect(formatAnswers([db], [['Postgres']])).toBe(
      'User has answered your questions: "Which database should we use?"="Postgres". You can now continue with the user\'s answers in mind.'
    )
    expect(formatAnswers([db], null)).toBe(
      'The user dismissed the questions. Continue with your best judgment.'
    )
  })
})
