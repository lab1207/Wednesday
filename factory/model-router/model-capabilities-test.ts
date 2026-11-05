/**
 * Offline test for model capability fit: pool parsing, deterministic
 * grading, best-per-capability selection (one model may win all roles),
 * fake-provider probing, dream-team assignment, registry fallback.
 * No network, no keys.
 */
import assert from 'node:assert/strict'

import {
  assignTeam,
  bestFitFor,
  CAPABILITY_PROBES,
  clearModelFit,
  getModelFit,
  gradeProbe,
  laneModelFor,
  parseModelPool,
  probePool,
  selectBestModel,
  setModelFit,
  type TeamRole,
  VISION_IMAGE_PROBE,
  VISION_PIXEL_PNG,
} from './model-capabilities'

async function main(): Promise<void> {
  // 1. Pool parsing: FACTORY_MODEL_POOL wins, trims, drops empties, dedupes.
  assert.deepEqual(
    parseModelPool({
      FACTORY_MODEL_POOL: ' strong-a@https://a/x , weak-b , strong-a@https://a/x ,, ',
    } as NodeJS.ProcessEnv),
    [
      { id: 'strong-a', baseURL: 'https://a/x' },
      { id: 'weak-b' },
    ],
  )
  // 2. Crew slots assemble when no POOL set.
  assert.deepEqual(
    parseModelPool({
      FACTORY_CREW_PLANNER_MODEL: 'plan-m',
      FACTORY_CREW_CODER_MODEL: 'code-m',
      FACTORY_CREW_VISION_MODEL: '',
    } as NodeJS.ProcessEnv),
    [{ id: 'plan-m' }, { id: 'code-m' }],
  )
  // 3. Legacy single fallback, and empty env yields empty pool.
  assert.deepEqual(
    parseModelPool({ LOCAL_LLM_MODEL: ' solo ' } as NodeJS.ProcessEnv),
    [{ id: 'solo' }],
  )
  assert.deepEqual(parseModelPool({} as NodeJS.ProcessEnv), [])

  // 4. Grading: full markers 100, partial in between, none 0.
  assert.equal(
    gradeProbe('coding', 'def add(a, b): return a + b'),
    100,
  )
  assert.equal(gradeProbe('coding', 'def add(a, b): pass'), 50)
  assert.equal(gradeProbe('coding', 'hello world'), 0)
  assert.equal(
    gradeProbe('reasoning', '1 first\n2 second\n3 third\nreturn done'),
    100,
  )
  assert.equal(gradeProbe('review', 'bug at index 1'), 100)
  assert.equal(gradeProbe('complete', 'def mul(a, b): return a * b'), 100)

  // 5. Selection: strongest wins; ties keep pool order; all-zero -> ''.
  const pool = [{ id: 'strong' }, { id: 'weak' }]
  const scores = {
    strong: { reasoning: 100, coding: 100, vision: 100, review: 100, complete: 100 },
    weak: { reasoning: 25, coding: 0, vision: 50, review: 0, complete: 0 },
  }
  assert.equal(selectBestModel('reasoning', pool, scores), 'strong')
  assert.equal(selectBestModel('coding', pool, scores), 'strong')
  assert.equal(selectBestModel('vision', pool, scores), 'strong')
  assert.equal(selectBestModel('review', pool, scores), 'strong')
  assert.equal(
    selectBestModel('coding', pool, {
      strong: { reasoning: 0, coding: 0, vision: 0, review: 0, complete: 0 },
      weak: { reasoning: 0, coding: 0, vision: 0, review: 0, complete: 0 },
    }),
    '',
    'all-zero must fall back, never force a winner',
  )

  // 6. Probe with a fake provider: strong answers markers, weak does not,
  //    vision-only answers vision only. Failures score 0, never throw.
  const fake = async (modelId: string, prompt: string): Promise<string> => {
    if (modelId === 'boom') throw new Error('dead box')
    if (modelId === 'strong') {
      if (prompt === CAPABILITY_PROBES.reasoning.prompt)
        return '1 plan\n2 code\n3 test\nreturn done'
      if (prompt === CAPABILITY_PROBES.coding.prompt)
        return 'def add(a, b): return a + b'
      if (prompt === CAPABILITY_PROBES.review.prompt)
        return 'bug at index 1'
      if (prompt === CAPABILITY_PROBES.complete.prompt)
        return 'def mul(a, b): return a * b'
      return 'a red square on a blue background'
    }
    if (modelId === 'seer') return 'red square blue background everywhere'
    return 'i do not know'
  }
  const probed = await probePool(
    [{ id: 'strong' }, { id: 'weak' }, { id: 'seer' }, { id: 'boom' }],
    fake,
  )
  assert.deepEqual(probed.strong, {
    reasoning: 100,
    coding: 100,
    vision: 100,
    review: 100,
    complete: 100,
  })
  assert.deepEqual(probed.boom, {
    reasoning: 0,
    coding: 0,
    vision: 0,
    review: 0,
    complete: 0,
  })
  assert.equal(probed.seer.vision, 100)
  assert.ok(
    probed.seer.reasoning < 100 && probed.seer.coding < 100,
    'narrow model must not win outside its strength',
  )

  // 7. Registry: winners serve; empty registry returns the fallback
  //    (legacy slot mapping preserved byte-for-byte off-probe).
  clearModelFit()
  assert.equal(bestFitFor('reasoning', 'legacy-r1'), 'legacy-r1')
  setModelFit([{ id: 'strong' }, { id: 'seer' }], probed)
  assert.equal(bestFitFor('reasoning', 'legacy-r1'), 'strong')
  assert.equal(bestFitFor('coding', 'legacy-coder'), 'strong')
  assert.equal(bestFitFor('vision', 'legacy-vl'), 'strong')
  assert.equal(bestFitFor('review', 'legacy-rev'), 'strong')
  const fit = getModelFit()
  assert.equal(fit.pool.length, 2)
  clearModelFit()
  assert.equal(bestFitFor('vision', 'legacy-vl'), 'legacy-vl')

  // 8. Dream-team: 4-model shape (architect+vision double-duty for the
  //    strong one, builder/completer/reviewer split by signal, fallback
  //    kept where no probe wins).
  const team4 = [
    { id: 'qwen-27b' },
    { id: 'devstral-24b' },
    { id: 'codestral-2' },
    { id: 'laguna-xs' },
  ]
  const teamScores = {
    'qwen-27b': { reasoning: 100, coding: 75, vision: 100, review: 100, complete: 50 },
    'devstral-24b': { reasoning: 50, coding: 100, vision: 0, review: 25, complete: 75 },
    'codestral-2': { reasoning: 25, coding: 75, vision: 0, review: 0, complete: 100 },
    'laguna-xs': { reasoning: 50, coding: 50, vision: 0, review: 75, complete: 25 },
  }
  const fallback: Record<TeamRole, string> = {
    architect: 'qwen-27b',
    debugger: 'qwen-27b',
    builder: 'devstral-24b',
    completer: 'codestral-2',
    reviewer: 'laguna-xs',
    scanner: 'laguna-xs',
    vision: 'qwen-27b',
  }
  const team = assignTeam(team4, teamScores, fallback)
  const at = (role: TeamRole): string =>
    team.find(entry => entry.role === role)?.model ?? ''
  assert.equal(at('architect'), 'qwen-27b')
  assert.equal(at('debugger'), 'qwen-27b')
  assert.equal(at('builder'), 'devstral-24b')
  assert.equal(at('completer'), 'codestral-2')
  assert.equal(at('reviewer'), 'qwen-27b')
  assert.equal(
    at('reviewer'),
    'qwen-27b',
    'best review scorer wins even when fallback names laguna',
  )
  assert.equal(at('vision'), 'qwen-27b')
  // No-signal pool keeps every fallback and says so.
  const empty = assignTeam([], {}, fallback)
  assert.ok(
    empty.every(entry => entry.model === fallback[entry.role]),
    'empty scores must keep all fallbacks',
  )
  assert.ok(
    empty.every(entry => entry.reason.includes('fallback')),
    'fallback reasons must say fallback',
  )

  // 9. Lane rotation: every model works every question, lane i
  //    runs pool[i % pool.length]; empty pool keeps solo fallback.
  const ten = [{ id: 'm0' }, { id: 'm1' }, { id: 'm2' }]
  assert.equal(laneModelFor(0, ten, 'solo-m'), 'm0')
  assert.equal(laneModelFor(2, ten, 'solo-m'), 'm2')
  assert.equal(laneModelFor(3, ten, 'solo-m'), 'm0')
  assert.equal(laneModelFor(10, ten, 'solo-m'), 'm1')
  assert.equal(laneModelFor(0, [], 'solo-m'), 'solo-m')
  assert.equal(laneModelFor(0, [{ id: 'only' }], 'solo-m'), 'only')

  // 10. Image probe (R-BM-28): with visionImages the vision step shows
  // the red pixel; the seer answers red, the blind guesses wrong.
  // e2e R-BM-28: red-pixel image probe
  const seen: Array<{ modelId: string; prompt: string; images?: string[] }> = []
  const imageFake = async (modelId: string, prompt: string, images?: string[]): Promise<string> => {
    seen.push({ modelId, prompt, images })
    if (modelId === 'seer') return 'red'
    return 'i cannot see images, blue maybe'
  }
  const imaged = await probePool(
    [{ id: 'seer' }, { id: 'blind' }],
    imageFake,
    [VISION_PIXEL_PNG],
  )
  assert.equal(imaged.seer!.vision, 100)
  assert.equal(imaged.blind!.vision, 0)
  const visionCalls = seen.filter(call => call.prompt === VISION_IMAGE_PROBE.prompt)
  assert.equal(visionCalls.length, 2)
  assert.ok(
    visionCalls.every(call => call.images?.length === 1),
    'vision calls must carry the pixel',
  )
  // Without images the text fallback still separates describers.
  const textOnly = await probePool([{ id: 'talker' }], async () => 'red square blue background')
  assert.equal(textOnly.talker!.vision, 100)

  console.log('MODEL CAPABILITIES TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
