/**
 * The coder's operative rules must survive a long prompt (2026-11-07).
 *
 * The coder prompt was capped with a head-only trim, so on any prompt over
 * 12,000 characters the tail -- the STRICT EXECUTION RULES block and the
 * FINAL REQUIREMENT -- was the FIRST thing discarded. The prompt was still
 * "valid"; it was just missing the instructions that tell the model how to
 * behave.
 *
 * These assertions are the regression: the rules survive, the task survives,
 * and a prompt that fits is returned byte for byte.
 */

import assert from 'node:assert/strict'
import {
  DEFAULT_TAIL_CHARS,
  limitPromptKeepingTail,
} from './prompt-trim'

const RULES = [
  'STRICT EXECUTION RULES:',
  '- Work directly in the specified workspace.',
  '- Use the exact required filenames.',
  '- Create the exact requested content.',
  '- Do not substitute another filename.',
  '- Do not create demonstration or example files.',
  '- Do not modify unrelated files.',
  '- Do not ask the user for another task.',
  '- Inspect the final result.',
  '- Verify the acceptance criteria before finishing.',
  '',
  'FINAL REQUIREMENT:',
  'Perform the task now.',
].join('\n')

function main(): void {
  // 1. A prompt that fits is returned UNCHANGED.
  const short = 'head\n\nbody\n\n' + RULES
  assert.equal(
    limitPromptKeepingTail(short, 12000),
    short,
    'a prompt that fits must not be touched',
  )

  // 2. A long prompt keeps its head and its operative tail.
  const filler = 'x'.repeat(30000)
  const long =
    'TASK: build me website\n\n' +
    filler +
    '\n\nPLANNER GUIDANCE:\n' +
    filler +
    '\n\n' +
    RULES

  const trimmed =
    limitPromptKeepingTail(long, 12000)

  assert.ok(
    trimmed.length <= 12000,
    `the trimmed prompt must fit the budget, got ${trimmed.length}`,
  )
  assert.ok(
    trimmed.startsWith('TASK: build me website'),
    'the task at the head must survive',
  )
  assert.ok(
    trimmed.includes('STRICT EXECUTION RULES:'),
    'the operative rules must survive a long prompt',
  )
  assert.ok(
    trimmed.includes('FINAL REQUIREMENT:'),
    'the final requirement must survive a long prompt',
  )
  assert.ok(
    trimmed.includes('Perform the task now.'),
    'the last line of the rules must survive a long prompt',
  )
  assert.ok(
    trimmed.includes('trimmed from the middle'),
    'a trimmed prompt must say so',
  )

  // 3. The middle is where the loss happens -- that is the point.
  assert.ok(
    !trimmed.includes(filler),
    'the bulky middle must be the part that is dropped',
  )

  // 4. The budget is respected with a TINY budget too.
  const tiny =
    limitPromptKeepingTail(
      long,
      600,
      DEFAULT_TAIL_CHARS,
    )

  assert.ok(
    tiny.length <= 600,
    `a tiny budget must still be respected, got ${tiny.length}`,
  )
  assert.ok(
    tiny.includes('Perform the task now.'),
    'the tail must survive even a tiny budget',
  )

  // 5. A budget too small for both ends keeps the TAIL, because the rules
  //    are the operative part.
  const starved =
    limitPromptKeepingTail(
      long,
      100,
    )

  assert.ok(
    starved.includes('Perform the task now.'),
    'the operative tail must win when the budget is too small for both ends',
  )

  console.log('prompt-trim: PASS')
}

main()
