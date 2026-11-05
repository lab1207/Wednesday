/**
 * Offline test for model cards: name priors, caps, effective merge.
 * No network, no keys.
 */
import assert from 'node:assert/strict'

import {
  effectiveScores,
  inferModelCard,
  priorFor,
} from './model-cards'

async function main(): Promise<void> {
  // 1. Tags: vision/code/reasoning markers, general otherwise.
  assert.deepEqual(inferModelCard('qwen2.5-vl-7b').tags, ['vision'])
  assert.equal(inferModelCard('qwen2.5-vl-7b').vision, true)
  assert.ok(inferModelCard('devstral-24b').tags.includes('code'))
  assert.ok(inferModelCard('deepseek-r1-7b').tags.includes('reasoning'))
  assert.deepEqual(inferModelCard('laguna-xs-2.1').tags, ['general'])
  assert.equal(inferModelCard('laguna-xs-2.1').vision, false)

  // 2. Priors capped: never above 50, review/complete spill at 25/50.
  const coder = priorFor('qwen2.5-coder-3b')
  assert.equal(coder.coding, 50)
  assert.equal(coder.complete, 50)
  assert.ok(coder.reasoning <= 50 && coder.vision <= 50)
  assert.deepEqual(priorFor('laguna-xs-2.1'), {
    reasoning: 0,
    coding: 0,
    vision: 0,
    review: 0,
    complete: 0,
  })

  // 3. Effective: probe wins everywhere it exists; prior fills zeros.
  const eff = effectiveScores(
    ['devstral-24b', 'mystery-m'],
    {
      'devstral-24b': {
        reasoning: 0,
        coding: 90,
        vision: 0,
        review: 0,
        complete: 0,
      },
    },
  )
  assert.equal(eff['devstral-24b'].coding, 90)
  assert.equal(eff['devstral-24b'].complete, 50)
  assert.equal(eff['devstral-24b'].vision, 0)
  assert.deepEqual(eff['mystery-m'], {
    reasoning: 0,
    coding: 0,
    vision: 0,
    review: 0,
    complete: 0,
  })

  console.log('MODEL CARDS TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
