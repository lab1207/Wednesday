/**
 * Offline test for the text-response checkers (Tier-3 path). No network,
 * no model: canned response strings prove green/red for every checker and
 * for gradeResponse composition. Runner wiring (prompt → crew text) is the
 * next slice; checker correctness is fully provable here.
 */
import assert from 'node:assert/strict'

import {
  containsAll,
  containsNone,
  exactMatch,
  gradeResponse,
  jsonShape,
  numericEqual,
  wordCountRange,
  type TextProblem,
} from './checkers'

function main(): void {
  // exactMatch: normalization-tolerant, content-strict.
  assert.equal(exactMatch('  hello   world ', 'hello world').passed, true)
  assert.equal(exactMatch('hello world', 'hello there').passed, false)

  // containsAll / containsNone.
  assert.equal(containsAll(['token', 'auth'])( 'use the token for auth', '').passed, true)
  assert.equal(containsAll(['token', 'auth'])('use the token', '').passed, false)
  assert.equal(containsNone(['password'])( 'use the token', '').passed, true)
  assert.equal(containsNone(['password'])('the password is x', '').passed, false)

  // wordCountRange boundaries inclusive.
  assert.equal(wordCountRange(2, 4)('one two three', '').passed, true)
  assert.equal(wordCountRange(2, 4)('one', '').passed, false)
  assert.equal(wordCountRange(2, 4)('one two three four five', '').passed, false)

  // numericEqual: boxed, trailing, fractions, tolerance.
  assert.equal(numericEqual('\\boxed{42}', '42').passed, true)
  assert.equal(numericEqual('The answer is 42', '42').passed, true)
  assert.equal(numericEqual('\\boxed{1/2}', '0.5').passed, true)
  assert.equal(numericEqual('\\boxed{43}', '42').passed, false)
  assert.equal(numericEqual('no numbers here', '42').passed, false)

  // jsonShape: validity + required keys.
  assert.equal(jsonShape(['token'])('{"token":"abc"}', '').passed, true)
  assert.equal(jsonShape(['token'])('{"user":"x"}', '').passed, false)
  assert.equal(jsonShape()('not json', '').passed, false)
  assert.equal(jsonShape()('[1,2]', '').passed, false)

  // gradeResponse: all-must-pass composition.
  const problem: TextProblem = {
    id: 'text/demo-1',
    prompt: 'Answer 42 briefly.',
    expected: '42',
    checkers: [containsAll(['42']), wordCountRange(1, 10)],
  }
  const green = gradeResponse(problem, 'The answer is 42')
  assert.equal(green.passed, true)
  const red = gradeResponse(problem, 'The answer is 43')
  assert.equal(red.passed, false)
  assert.ok(red.detail.length > 0)

  console.log('TEXT CHECKERS TEST: PASS (all checkers green/red, composition)')
}

main()
