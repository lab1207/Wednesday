/**
 * Offline test for relay memory. Pure asserts: recording, win-rate
 * bonus, attempt floor, 100-cap, unknown passthrough, clear.
 */
import assert from 'node:assert/strict'

import {
  applyRelayMemory,
  clearRelayMemory,
  getRelayMemory,
  memoryKey,
  recordRelayOutcome,
} from './relay-memory'

async function main(): Promise<void> {
  clearRelayMemory()

  // 1. Recording counts wins and attempts per model x capability.
  recordRelayOutcome('hands', 'coding', true)
  recordRelayOutcome('hands', 'coding', false)
  recordRelayOutcome('hands', 'vision', true)
  assert.deepEqual(getRelayMemory()[memoryKey('hands', 'coding')], {
    wins: 1,
    attempts: 2,
  })

  // 2. Bonus needs 2+ attempts: 1/1 earns nothing (no fluke promotion),
  // while 1/2 already counts (two data points, half right).
  recordRelayOutcome('fresh', 'coding', true)
  const base = {
    hands: { reasoning: 0, coding: 80, vision: 60, review: 0, complete: 0 },
    eyes: { reasoning: 0, coding: 0, vision: 90, review: 0, complete: 0 },
    fresh: { reasoning: 0, coding: 70, vision: 0, review: 0, complete: 0 },
  }
  const once = applyRelayMemory(base)
  assert.equal(once.fresh!.coding, 70)
  assert.equal(once.hands!.coding, 93)
  assert.equal(once.hands!.vision, 60)

  // 3. Proven winners earn up to +25 by win rate.
  recordRelayOutcome('hands', 'coding', true) // 2/3 -> +17
  recordRelayOutcome('eyes', 'vision', true)
  recordRelayOutcome('eyes', 'vision', true) // 3/3 -> +25, capped at 100
  const learned = applyRelayMemory(base)
  assert.equal(learned.hands!.coding, 97)
  assert.equal(learned.eyes!.vision, 100)
  assert.equal(learned.eyes!.coding, 0, 'unplayed skills gain nothing')
  assert.equal(learned.fresh!.coding, 70, 'single attempt still earns nothing')

  // 4. Unknown models pass through untouched.
  const extended = applyRelayMemory({ ...base, newbie: { reasoning: 10, coding: 10, vision: 10, review: 10, complete: 10 } })
  assert.deepEqual(extended.newbie, {
    reasoning: 10,
    coding: 10,
    vision: 10,
    review: 10,
    complete: 10,
  })
  assert.equal(extended.fresh!.coding, 70)

  // 5. Clear wipes the slate.
  clearRelayMemory()
  assert.deepEqual(getRelayMemory(), {})
  assert.deepEqual(applyRelayMemory(base).hands, base.hands)

  console.log('RELAY MEMORY TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
