import assert from 'node:assert/strict'
import {
  buildClarificationBlock,
  collectSeatText,
  MAX_CLARIFICATION_QUESTIONS,
  parseClarificationQuestions,
} from './clarification.js'

// ---------------------------------------------------------------------------
// THE PARSER (2026-11-10, operator report: "the stage architect and planner
// don't ask question they just go? ... they must ask relevant question
// related the task then next and so on").
//
// The seat writes its questions under QUESTIONS:. The parser has to find them
// in whatever shape the model wrote them -- and the seat body ITSELF contains
// the word "QUESTIONS:", so the parser must never be pointed at a prompt.
// ---------------------------------------------------------------------------

// The ordinary shape: a section at the end of the answer.
{
  const questions = parseClarificationQuestions(
    [
      '- WHAT I READ: src/login.ts',
      '- THE DESIGN: rewrite the login form',
      'QUESTIONS:',
      '1. Should the old /login endpoint stay for backwards compatibility?',
      '2. Do you want a spinner while the provider is slow?',
    ].join('\n'),
  )
  assert.deepEqual(questions, [
    'Should the old /login endpoint stay for backwards compatibility?',
    'Do you want a spinner while the provider is slow?',
  ])
}

// "QUESTIONS: none" means the seat has everything it needs. This is the
// normal case and it must NEVER become a pause.
{
  assert.deepEqual(parseClarificationQuestions('QUESTIONS: none'), [])
  assert.deepEqual(parseClarificationQuestions('QUESTIONS: None'), [])
  assert.deepEqual(parseClarificationQuestions('QUESTIONS: N/A'), [])
  assert.deepEqual(parseClarificationQuestions('QUESTIONS:\nnone'), [])
}

// No section at all: no questions.
{
  assert.deepEqual(parseClarificationQuestions('- THE DESIGN: do the thing'), [])
  assert.deepEqual(parseClarificationQuestions(''), [])
}

// The marker at the end of a sentence, with the question on the same line.
{
  const questions = parseClarificationQuestions(
    'I need one thing before I design. QUESTIONS: Which auth provider should this use?',
  )
  assert.deepEqual(questions, [
    'Which auth provider should this use?',
  ])
}

// Bulleted questions.
{
  const questions = parseClarificationQuestions(
    [
      'QUESTIONS:',
      '- Should the cache be per-user or global?',
      '* Do we keep the legacy route?',
    ].join('\n'),
  )
  assert.deepEqual(questions, [
    'Should the cache be per-user or global?',
    'Do we keep the legacy route?',
  ])
}

// Two questions on one line.
{
  const questions = parseClarificationQuestions(
    'QUESTIONS: Which database do you want? Should the seed data ship?',
  )
  assert.deepEqual(questions, [
    'Which database do you want?',
    'Should the seed data ship?',
  ])
}

// A question that spans two lines.
{
  const questions = parseClarificationQuestions(
    [
      'QUESTIONS:',
      '1. Which one do you want:',
      '   the fast one or the slow one?',
    ].join('\n'),
  )
  assert.deepEqual(questions, [
    'Which one do you want: the fast one or the slow one?',
  ])
}

// A section AFTER the questions ends the questions block: the report that
// follows is not more questions.
{
  const questions = parseClarificationQuestions(
    [
      'QUESTIONS:',
      'Which database do you want?',
      '',
      'RISK: the migration locks the table',
    ].join('\n'),
  )
  assert.deepEqual(questions, [
    'Which database do you want?',
  ])
}

// A line that ends in a question mark is a question even when it looks like
// a section header.
{
  const questions = parseClarificationQuestions(
    [
      'QUESTIONS:',
      'API: should the old endpoint stay?',
    ].join('\n'),
  )
  assert.deepEqual(questions, [
    'API: should the old endpoint stay?',
  ])
}

// The cap: three questions, because a form is not a conversation.
{
  const questions = parseClarificationQuestions(
    [
      'QUESTIONS:',
      'One?',
      'Two?',
      'Three?',
      'Four?',
      'Five?',
    ].join('\n'),
  )
  assert.equal(questions.length, MAX_CLARIFICATION_QUESTIONS)
  assert.equal(questions[0], 'One?')
  assert.equal(questions[2], 'Three?')
}

// The LAST marker wins: a seat that mentions the word in passing and writes
// the section at the end means the section at the end.
{
  const questions = parseClarificationQuestions(
    [
      'I will put my questions under QUESTIONS: below.',
      'QUESTIONS:',
      'What is the target platform?',
    ].join('\n'),
  )
  assert.deepEqual(questions, [
    'What is the target platform?',
  ])
}

// Windows line endings are the same document.
{
  const questions = parseClarificationQuestions(
    'THE DESIGN: x\r\nQUESTIONS:\r\nShould it be cached?\r\n',
  )
  assert.deepEqual(questions, ['Should it be cached?'])
}

// ---------------------------------------------------------------------------
// THE SEAT TEXT: the parser must never see the PROMPT.
// ---------------------------------------------------------------------------

// The model runner's `instructions` field holds the PROMPT it sent, and that
// prompt contains the words "QUESTIONS:" because the seat body teaches the
// shape. Reading it would find the template and ask the operator a question
// the model never asked.
{
  const text = collectSeatText({
    summary: 'architect produced a model-driven analysis.',
    findings: ['QUESTIONS:\nShould it be cached?'],
    instructions: '... write your questions under QUESTIONS: ...',
  })
  assert.deepEqual(
    parseClarificationQuestions(text),
    ['Should it be cached?'],
    'the prompt is not part of the seat text',
  )
}

// A seat with no findings still has its summary.
{
  assert.equal(
    collectSeatText({ summary: 'nothing here' }),
    'nothing here',
  )
}

// ---------------------------------------------------------------------------
// THE ANSWERS, as the seat sees them on its next run.
// ---------------------------------------------------------------------------

{
  const block = buildClarificationBlock([
    {
      question: 'Which database do you want?',
      answer: 'Postgres',
    },
  ])
  assert.match(block, /THE OPERATOR ANSWERED YOUR QUESTIONS/)
  assert.match(block, /Q1: Which database do you want\?/)
  assert.match(block, /A1: Postgres/)
  assert.match(block, /do not ask them again/i)
}

// No answers, no block: the prompt is unchanged.
{
  assert.equal(buildClarificationBlock([]), '')
}

console.log(
  'CLARIFICATION TEST: PASS (parser shapes, the none marker, the cap, the prompt is never parsed, the answer block)',
)
