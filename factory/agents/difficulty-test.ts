/**
 * Offline test for the difficulty meter. No network, no model: bands,
 * escalation ladder, and signal routing must be exact.
 */
import assert from 'node:assert/strict'

import {
  bandMaxAgents,
  escalateLevel,
  scoreDifficulty,
} from './difficulty'

async function main(): Promise<void> {
  // 1. Bands match the user-locked ladder.
  assert.equal(bandMaxAgents('low'), 5)
  assert.equal(bandMaxAgents('medium'), 12)
  assert.equal(bandMaxAgents('high'), 22)
  assert.ok(bandMaxAgents('very-high') >= 22)
  assert.ok(bandMaxAgents('max') > bandMaxAgents('very-high'))

  // 2. Escalation climbs one step and caps at max.
  assert.equal(escalateLevel('low'), 'medium')
  assert.equal(escalateLevel('high'), 'very-high')
  assert.equal(escalateLevel('max'), 'max')

  // 3. Small plain task → low.
  const small = scoreDifficulty({ objective: 'Fix typo in README', stack: 'markdown' })
  assert.equal(small.level, 'low')
  assert.equal(small.maxAgents, 5)
  assert.ok(small.reasons.length > 0, 'reasons recorded for evidence')

  // 4. Security surface → at least medium.
  const auth = scoreDifficulty({ objective: 'Fix auth token leak on login retry', stack: 'python' })
  assert.ok(['medium', 'high', 'very-high', 'max'].includes(auth.level))

  // 5. Concurrency/distribution → high.
  const dist = scoreDifficulty({ objective: 'Fix race in parallel pipeline workers', stack: 'python' })
  assert.equal(dist.level, 'high')

  // 6. Repair history escalates: 0 → low, 2 → medium+, 4 → high, 7 → very-high.
  const r0 = scoreDifficulty({ objective: 'Fix typo', failedAttempts: 0 })
  const r2 = scoreDifficulty({ objective: 'Fix typo', failedAttempts: 2 })
  const r4 = scoreDifficulty({ objective: 'Fix typo', failedAttempts: 4 })
  const r7 = scoreDifficulty({ objective: 'Fix typo', failedAttempts: 7 })
  assert.equal(r0.level, 'low')
  assert.ok(r2.maxAgents >= r0.maxAgents)
  assert.equal(r4.level, 'high')
  assert.equal(r7.level, 'very-high')

  console.log('DIFFICULTY TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
