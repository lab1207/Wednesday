/**
 * Offline test for the solo tryout gate: admit/mute lines, boundary,
 * empty evidence, tunable thresholds. No network.
 */
import assert from 'node:assert/strict'

import {
  qualifyForTeam,
  tryoutThresholds,
} from './model-qualify'

async function main(): Promise<void> {
  // 1. Strong solo: admit.
  const strong = qualifyForTeam({
    solved: 4,
    total: 5,
    repairsHelped: 1,
    repairsTotal: 2,
    reviewerPass: 4,
    reviewerTotal: 5,
  })
  assert.equal(strong.admitted, true)
  assert.equal(strong.passRate, 0.8)
  assert.ok(strong.reasons.some(reason => reason.startsWith('ADMIT')))

  // 2. Weak solo (the 1/64 shape): mute, evidence kept.
  const weak = qualifyForTeam({
    solved: 1,
    total: 64,
    repairsHelped: 1,
    repairsTotal: 63,
    reviewerPass: 1,
    reviewerTotal: 64,
  })
  assert.equal(weak.admitted, false)
  assert.ok(weak.reasons.some(reason => reason.startsWith('MUTE')))

  // 3. Boundary admits (>=, not >).
  const edge = qualifyForTeam(
    { solved: 1, total: 2, repairsHelped: 0, repairsTotal: 0, reviewerPass: 1, reviewerTotal: 2 },
    { minPass: 0.5, minReview: 0.5 },
  )
  assert.equal(edge.admitted, true)

  // 4. No evidence: always mute.
  const empty = qualifyForTeam({
    solved: 0,
    total: 0,
    repairsHelped: 0,
    repairsTotal: 0,
    reviewerPass: 0,
    reviewerTotal: 0,
  })
  assert.equal(empty.admitted, false)

  // 5. Thresholds tunable via env, junk falls back.
  assert.deepEqual(
    tryoutThresholds({ FACTORY_TRYOUT_MIN_PASS: '0.7' } as NodeJS.ProcessEnv),
    { minPass: 0.7, minReview: 0.5 },
  )
  assert.deepEqual(
    tryoutThresholds({ FACTORY_TRYOUT_MIN_PASS: 'junk' } as NodeJS.ProcessEnv),
    { minPass: 0.5, minReview: 0.5 },
  )

  console.log('MODEL QUALIFY TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
