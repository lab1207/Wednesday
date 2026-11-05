/**
 * Offline test for crew routing + thinking-strip. Pure asserts only —
 * no network, no Colab, no weights.
 */
import assert from 'node:assert/strict'

import {
  crewBaseURLForModel,
  crewSlotFor,
  isCrewPoolConfigured,
  resolveCrewBaseURL,
  resolveCrewModel,
  resolveLocalBaseURL,
  stripThinking,
  TRIO_CODER_MODEL,
  TRIO_PLANNER_MODEL,
  TRIO_VISION_MODEL,
} from './crew-routing'

async function main(): Promise<void> {
  // 1. Role map: planners plan, builders type, vision sees.
  assert.equal(crewSlotFor('architect'), 'planner')
  assert.equal(crewSlotFor('planner'), 'planner')
  assert.equal(crewSlotFor('coder'), 'coder')
  assert.equal(crewSlotFor('tester'), 'coder')
  assert.equal(crewSlotFor('reviewer'), 'coder')
  assert.equal(crewSlotFor('vision'), 'vision')
  assert.equal(crewSlotFor('something-new'), 'coder')

  // 2. Defaults match the Crew 1 catalog; env overrides per slot.
  assert.equal(resolveCrewModel('planner', {}), TRIO_PLANNER_MODEL)
  assert.equal(resolveCrewModel('coder', {}), TRIO_CODER_MODEL)
  assert.equal(resolveCrewModel('vision', {}), TRIO_VISION_MODEL)
  assert.equal(
    resolveCrewModel('planner', { FACTORY_CREW_PLANNER_MODEL: ' custom-r1 ' }),
    'custom-r1',
  )
  assert.equal(
    resolveCrewModel('coder', { FACTORY_CREW_PLANNER_MODEL: 'custom-r1' }),
    TRIO_CODER_MODEL,
    'planner override must not leak into the coder slot',
  )

  // 3. Strip: closed blocks, unclosed tails, stray tags go; clean text stays.
  assert.equal(
    stripThinking('<think>hmm, let me reason</think>print("hi")'),
    'print("hi")',
  )
  assert.equal(
    stripThinking('print("hi")<think>trailing cutoff'),
    'print("hi")',
  )
  assert.equal(stripThinking('plain answer, no tags'), 'plain answer, no tags')
  assert.equal(stripThinking('a</think>b<think>c'), 'ab')

  // 4. Tunnels: one default, every slot independently overridable.
  assert.equal(
    resolveLocalBaseURL({}),
    'http://127.0.0.1:1337/v1',
  )
  assert.equal(
    resolveLocalBaseURL({ LOCAL_LLM_BASE_URL: 'https://a.ngrok-free.dev/v1/' }),
    'https://a.ngrok-free.dev/v1',
  )
  const dual = {
    LOCAL_LLM_BASE_URL: 'https://a.ngrok-free.dev/v1',
    FACTORY_CREW_VISION_BASE_URL: 'https://b.ngrok-free.dev/v1/',
  }
  assert.equal(resolveCrewBaseURL('planner', dual), 'https://a.ngrok-free.dev/v1')
  assert.equal(resolveCrewBaseURL('coder', dual), 'https://a.ngrok-free.dev/v1')
  assert.equal(resolveCrewBaseURL('vision', dual), 'https://b.ngrok-free.dev/v1')
  assert.equal(
    crewBaseURLForModel(TRIO_PLANNER_MODEL, dual),
    'https://a.ngrok-free.dev/v1',
  )
  assert.equal(
    crewBaseURLForModel(TRIO_VISION_MODEL, dual),
    'https://b.ngrok-free.dev/v1',
  )
  assert.equal(
    crewBaseURLForModel('unknown-model', dual),
    'https://a.ngrok-free.dev/v1',
    'unknown ids use the default tunnel',
  )

  // 5. Pool detection: trio routing activates only on a connected pool.
  assert.equal(isCrewPoolConfigured({}), false)
  assert.equal(
    isCrewPoolConfigured({ FACTORY_CREW_CODER_MODEL: 'my-coder' }),
    true,
  )
  assert.equal(
    crewBaseURLForModel(TRIO_PLANNER_MODEL, {}),
    'http://127.0.0.1:1337/v1',
    'no pool means the single default tunnel for every id',
  )

  console.log('CREW ROUTING TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
