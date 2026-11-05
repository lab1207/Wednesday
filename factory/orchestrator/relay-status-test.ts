/**
 * Offline test for relay visibility: snapshot registry plus status
 * rendering. Pure asserts over explicit snapshots; the live snapshot
 * defaults in only when the caller omits it.
 * No network, no filesystem.
 */
// e2e R-BM-25: tree visible in status
// e2e R-BS-27: stuck leaves surface in status
import assert from 'node:assert/strict'

import { renderStatus } from '../harness/status'
import {
  clearRelaySnapshot,
  getRelaySnapshot,
  setRelaySnapshot,
} from './relay-status'

async function main(): Promise<void> {
  clearRelaySnapshot()
  assert.equal(getRelaySnapshot(), null)

  // 1. Registry round-trips.
  setRelaySnapshot({
    roundsUsed: 2,
    maxRounds: 5,
    open: ['piece-1'],
    solved: 3,
    failed: [],
    stuck: [],
  })
  assert.deepEqual(getRelaySnapshot(), {
    roundsUsed: 2,
    maxRounds: 5,
    open: ['piece-1'],
    solved: 3,
    failed: [],
    stuck: [],
  })

  // 2. Status renders the live tree, stuck leaves flagged.
  setRelaySnapshot({
    roundsUsed: 2,
    maxRounds: 5,
    open: ['piece-1'],
    solved: 3,
    failed: ['piece-0'],
    stuck: ['piece-0'],
  })
  const live = renderStatus({ FACTORY_RELAY: '1' })
  assert.ok(live.includes('Relay: round 2/5'), 'round counter renders')
  assert.ok(live.includes('open 1 (piece-1)'), 'open leaf renders')
  assert.ok(live.includes('solved 3'), 'solved count renders')
  assert.ok(live.includes('failed 1'), 'failed count renders')
  assert.ok(live.includes('STUCK piece-0'), 'stuck leaf flags')

  // 3. Explicit snapshots keep renderStatus pure (no registry read).
  clearRelaySnapshot()
  const idle = renderStatus({ FACTORY_RELAY: '1' }, null)
  assert.ok(idle.includes('Relay: on (no round yet this process)'))
  const off = renderStatus({}, null)
  assert.ok(off.includes('Relay: off (FACTORY_RELAY=1 to team up)'))
  const injected = renderStatus({}, {
    roundsUsed: 1,
    maxRounds: 5,
    open: [],
    solved: 2,
    failed: [],
    stuck: [],
  })
  assert.ok(injected.includes('Relay: round 1/5'))

  clearRelaySnapshot()
  console.log('RELAY STATUS TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
