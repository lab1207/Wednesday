/**
 * Unit test for the captain fallback policy (2026-09-27). Pure asserts
 * only: gates, prompts, scoring, picks, judgment parsing. No models,
 * no network.
 */
import assert from 'node:assert/strict'

import {
  buildCaptainAttemptPrompt,
  buildCaptainGuidance,
  buildCaptainJudgePrompt,
  parseCaptainJudgment,
  pickCaptain,
  resolveCaptainEnabled,
  resolveCaptainMinScore,
  scoreAttempt,
  type CaptainCandidate,
} from './captain'

function candidate(
  lens: CaptainCandidate['lens'],
  score: number,
): CaptainCandidate {
  return { lens, score, attemptText: `${lens} try`, requiredChanges: [] }
}

async function main(): Promise<void> {
  // 1. Gates: explicit opt-in only; bar defaults 30, clamped.
  {
    assert.equal(resolveCaptainEnabled({}), false)
    assert.equal(resolveCaptainEnabled({ FACTORY_CAPTAIN: '1' }), true)
    assert.equal(resolveCaptainEnabled({ FACTORY_CAPTAIN: 'On' }), true)
    assert.equal(resolveCaptainEnabled({ FACTORY_CAPTAIN: 'junk' }), false)
    assert.equal(resolveCaptainMinScore({}), 30)
    assert.equal(resolveCaptainMinScore({ FACTORY_CAPTAIN_MIN_SCORE: '50' }), 50)
    assert.equal(resolveCaptainMinScore({ FACTORY_CAPTAIN_MIN_SCORE: '0' }), 1)
    assert.equal(resolveCaptainMinScore({ FACTORY_CAPTAIN_MIN_SCORE: '999' }), 100)
    assert.equal(resolveCaptainMinScore({ FACTORY_CAPTAIN_MIN_SCORE: 'junk' }), 30)
    console.log('CAPTAIN: gates default off, bar defaults 30')
  }

  // 2. Attempt prompts carry the task + history, lens-framed.
  {
    const prompt = buildCaptainAttemptPrompt(
      'coder',
      { objective: 'Fix the widget.', stack: 'python' },
      [{ attempt: 1, reason: ['coder wrote nothing usable'] }],
    )
    assert.ok(prompt.includes('Fix the widget.'))
    assert.ok(prompt.includes('coder wrote nothing usable'))
    assert.ok(prompt.includes('never ship'))
    const planner = buildCaptainAttemptPrompt('planner', { objective: 'x' }, [])
    assert.ok(planner.includes('recovery plan'))
    assert.ok(planner.includes('(no recorded attempts)'))
    console.log('CAPTAIN: attempt prompts task-only, capped, lens-framed')
  }

  // 3. Partial-credit scoring: closed fraction of criteria.
  {
    assert.equal(scoreAttempt(4, ['a', 'b']), 50)
    assert.equal(scoreAttempt(10, ['a', 'b', 'c']), 70)
    assert.equal(scoreAttempt(3, []), 100)
    assert.equal(scoreAttempt(2, ['a', 'b', 'c', 'd']), 0)
    assert.equal(scoreAttempt(0, []), 100)
    assert.equal(scoreAttempt(0, ['a']), 0)
    console.log('CAPTAIN: partial credit is the closed fraction')
  }

  // 4. Picks: bar enforced, best wins, ties break planner-first.
  {
    assert.equal(pickCaptain([], 30), null)
    assert.equal(
      pickCaptain([candidate('coder', 20)], 30),
      null,
      'below the bar nominates nobody',
    )
    assert.equal(
      pickCaptain([candidate('coder', 30), candidate('vision', 80)], 30)?.lens,
      'vision',
    )
    assert.equal(
      pickCaptain([candidate('vision', 60), candidate('planner', 60)], 30)?.lens,
      'planner',
      'ties break plan-beats-code-beats-sight',
    )
    console.log('CAPTAIN: bar enforced, best wins, ties planner-first')
  }

  // 5. Judgment parsing: explicit PASS only; changes counted, capped.
  {
    const pass = parseCaptainJudgment('VERDICT: PASS\nAll good.')
    assert.deepEqual(pass, { passed: true, requiredChanges: [] })
    const fail = parseCaptainJudgment('VERDICT: FAIL\nOPEN:\n1. Missing file.\n2. Wrong id type.')
    assert.equal(fail.passed, false)
    assert.deepEqual(fail.requiredChanges, ['Missing file.', 'Wrong id type.'])
    const sneaky = parseCaptainJudgment('VERDICT: PASS\n1. Still broken.')
    assert.equal(sneaky.passed, false, 'PASS with open items is not a pass')
    const empty = parseCaptainJudgment('no idea')
    assert.deepEqual(empty, { passed: false, requiredChanges: [] })
    console.log('CAPTAIN: judgment parsing lenient, PASS strict')
  }

  // 6. Guidance shaping mirrors the recovery adoption shape.
  {
    const guidance = buildCaptainGuidance(candidate('coder', 50), 'round 1/1')
    assert.ok(guidance.summary.includes('Captain coder nominated'))
    assert.ok(guidance.summary.includes('never shipped'))
    assert.ok(guidance.recommendations[0].includes('score 50'))
    assert.ok(buildCaptainJudgePrompt('coder', 'try').includes('VERDICT: PASS'))
    console.log('CAPTAIN: guidance lands as planner-visible adoption')
  }

  console.log('CAPTAIN POLICY TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
