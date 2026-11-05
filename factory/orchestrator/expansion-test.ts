/**
 * Offline test for the expansion policy. Pure asserts: band map,
 * escalation ladder, env overrides, width clamps, vote tally —
 * no runners, no network, no filesystem.
 */
import assert from 'node:assert/strict'

import {
  baseModeForLevel,
  duelWidthFor,
  escalateMode,
  resolveExpansion,
  resolveExpansionOverride,
  tallyReviewVotes,
  voteWidthFor,
} from './expansion'

async function main(): Promise<void> {
  // 1. Band map: easy solo, medium vote, hard duel.
  assert.equal(baseModeForLevel('low'), 'solo')
  assert.equal(baseModeForLevel('medium'), 'vote')
  assert.equal(baseModeForLevel('high'), 'duel')
  assert.equal(baseModeForLevel('very-high'), 'duel')
  assert.equal(baseModeForLevel('max'), 'duel')

  // 2. Escalation: one step per failed round, capped at duel.
  assert.equal(escalateMode('solo', 0), 'solo')
  assert.equal(escalateMode('solo', 1), 'vote')
  assert.equal(escalateMode('solo', 5), 'duel')
  assert.equal(escalateMode('vote', 1), 'duel')
  assert.equal(escalateMode('duel', 3), 'duel')

  // 3. Overrides: off/solo pin solo, duel/vote pin, junk → auto.
  assert.equal(resolveExpansionOverride({}), 'auto')
  assert.equal(resolveExpansionOverride({ FACTORY_EXPANSION: 'off' }), 'solo')
  assert.equal(resolveExpansionOverride({ FACTORY_EXPANSION: 'duel' }), 'duel')
  assert.equal(resolveExpansionOverride({ FACTORY_EXPANSION: 'junk' }), 'auto')

  // 4. Full decision: band + round + widths.
  assert.deepEqual(resolveExpansion({ level: 'low', failedRounds: 0, env: {} }), {
    mode: 'solo',
    duelWidth: 1,
    voteWidth: 1,
  })
  assert.deepEqual(
    resolveExpansion({ level: 'low', failedRounds: 1, env: {} }),
    { mode: 'vote', duelWidth: 1, voteWidth: 3 },
  )
  assert.deepEqual(
    resolveExpansion({ level: 'high', failedRounds: 0, env: {} }),
    { mode: 'duel', duelWidth: 2, voteWidth: 1 },
  )
  assert.deepEqual(
    resolveExpansion({ level: 'max', failedRounds: 0, env: {} }),
    { mode: 'duel', duelWidth: 3, voteWidth: 1 },
  )
  assert.deepEqual(
    resolveExpansion({ level: 'high', failedRounds: 0, env: { FACTORY_DUEL_WIDTH: '900' } }),
    { mode: 'duel', duelWidth: 300, voteWidth: 1 },
  )
  assert.deepEqual(
    resolveExpansion({ level: 'high', failedRounds: 0, env: { FACTORY_DUEL_WIDTH: '6' } }),
    { mode: 'duel', duelWidth: 6, voteWidth: 1 },
  )
  assert.deepEqual(
    resolveExpansion({ level: 'medium', failedRounds: 0, env: { FACTORY_EXPANSION: 'solo' } }),
    { mode: 'solo', duelWidth: 1, voteWidth: 1 },
  )

  // 5. Widths: clamps + odd-only votes.
  assert.equal(duelWidthFor('high', {}), 2)
  assert.equal(duelWidthFor('high', { FACTORY_DUEL_WIDTH: '1' }), 1)
  assert.equal(duelWidthFor('high', { FACTORY_DUEL_WIDTH: 'junk' }), 2)
  assert.equal(voteWidthFor({}), 3)
  assert.equal(voteWidthFor({ FACTORY_VOTE_WIDTH: '2' }), 3)
  assert.equal(voteWidthFor({ FACTORY_VOTE_WIDTH: '5' }), 5)

  // 6. Tally: majority pass ships, ties and blanks fail.
  assert.deepEqual(tallyReviewVotes([{ review: { verdict: 'pass' } }]), {
    verdict: 'pass',
    passes: 1,
    fails: 0,
    findings: [],
  })
  const split = tallyReviewVotes([
    { review: { verdict: 'pass' } },
    { review: { verdict: 'fail' } },
    {},
  ])
  assert.equal(split.verdict, 'fail')
  assert.equal(split.passes, 1)
  assert.equal(split.fails, 2)
  const majority = tallyReviewVotes([
    { review: { verdict: 'pass' } },
    { review: { verdict: 'pass' } },
    { review: { verdict: 'fail' } },
  ])
  assert.equal(majority.verdict, 'pass')

  console.log('EXPANSION POLICY TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
