/**
 * Offline test for the model volume mixer: parsing, mute, weighted
 * pick (injected rand), proportional lanes, lineup. No network.
 */
import assert from 'node:assert/strict'

import {
  allocateLanes,
  enabledPool,
  laneLineup,
  parseModelWeights,
  pickWeighted,
  weightFor,
} from './model-weights'

async function main(): Promise<void> {
  const pool = [{ id: 'qwen-27b' }, { id: 'devstral-24b' }, { id: 'laguna-xs' }]

  // 1. Parse: clamps, drops junk + unknown ids, trims.
  assert.deepEqual(
    parseModelWeights(
      { FACTORY_MODEL_WEIGHTS: ' qwen-27b:80, devstral-24b:0, junk, ghost:70, laguna-xs:150 ' } as NodeJS.ProcessEnv,
      pool.map(model => model.id),
    ),
    { 'qwen-27b': 80, 'devstral-24b': 0, 'laguna-xs': 100 },
  )
  assert.deepEqual(parseModelWeights({} as NodeJS.ProcessEnv), {})

  // 2. Defaults + mute.
  assert.equal(weightFor('qwen-27b', {}), 50)
  assert.equal(weightFor('devstral-24b', { 'devstral-24b': 0 }), 0)
  assert.deepEqual(
    enabledPool(pool, { 'devstral-24b': 0 }).map(model => model.id),
    ['qwen-27b', 'laguna-xs'],
  )

  // 3. Weighted pick with injected rand (80 vs 20 over total 100).
  const weights = { 'qwen-27b': 80, 'devstral-24b': 20 }
  assert.equal(pickWeighted(['qwen-27b', 'devstral-24b'], weights, () => 0), 'qwen-27b')
  assert.equal(pickWeighted(['qwen-27b', 'devstral-24b'], weights, () => 0.79), 'qwen-27b')
  assert.equal(pickWeighted(['qwen-27b', 'devstral-24b'], weights, () => 0.81), 'devstral-24b')
  assert.equal(pickWeighted([], weights), '')

  // 4. Lanes: 10 lanes over 80/20/0 split 8/2/0, sums exact.
  const lanes = allocateLanes(pool, { 'qwen-27b': 80, 'devstral-24b': 20, 'laguna-xs': 0 }, 10)
  assert.deepEqual(lanes, [
    { id: 'qwen-27b', lanes: 8 },
    { id: 'devstral-24b', lanes: 2 },
  ])
  const total = lanes.reduce((sum, row) => sum + row.lanes, 0)
  assert.equal(total, 10)

  // 5. Lineup: favorite appears proportionally more; muted never.
  const lineup = laneLineup(pool, { 'qwen-27b': 80, 'devstral-24b': 20, 'laguna-xs': 0 }, 5)
  assert.equal(lineup.length, 5)
  assert.equal(lineup.filter(id => id === 'qwen-27b').length, 4)
  assert.equal(lineup.filter(id => id === 'devstral-24b').length, 1)
  assert.ok(!lineup.includes('laguna-xs'), 'muted model must never run')
  assert.deepEqual(laneLineup(pool, { 'qwen-27b': 0, 'devstral-24b': 0, 'laguna-xs': 0 }, 5), [])

  console.log('MODEL WEIGHTS TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
