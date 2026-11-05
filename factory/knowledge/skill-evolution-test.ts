/**
 * Offline test for the skill-evolution doctrine adapter. Static content
 * proves the single-card shape, cap, engine hygiene (no training-engine
 * machinery), and miss behavior.
 */
import assert from 'node:assert/strict'

import { SkillEvolutionAdapter, SKILL_EVOLUTION_PREFIX } from './skill-evolution'

async function main(): Promise<void> {
  const adapter = new SkillEvolutionAdapter()

  // 1. Catalog: one card, documented, model-invocable.
  const listed = await adapter.list()
  assert.deepEqual(
    listed.map(skill => skill.name),
    [`${SKILL_EVOLUTION_PREFIX}skill-evolution`],
  )
  assert.ok(listed[0].description.length > 20)
  assert.ok((listed[0].whenToUse ?? '').length > 20)
  assert.equal(listed[0].invocation.modelInvocable, true)

  // 2. Load: content present, capped, sourced.
  const loaded = await adapter.load(`${SKILL_EVOLUTION_PREFIX}skill-evolution`)
  assert.ok(loaded)
  assert.ok(loaded.content.length > 200)
  assert.ok(loaded.content.length <= 2000, `cap holds, got ${loaded.content.length}`)
  assert.equal(loaded.source, 'skillopt-distilled')
  assert.equal(loaded.provider, 'microsoft')

  // 3. Hygiene: doctrine only — no training-engine machinery.
  for (const leaked of ['pip install', 'skillopt-train', 'Azure', 'benchmark split', 'lr_scheduler']) {
    assert.ok(
      !loaded.content.includes(leaked),
      `distilled content must not carry engine machinery: ${leaked}`,
    )
  }
  assert.ok(loaded.content.includes('Gate rule'), 'gate survives')
  assert.ok(loaded.content.includes('Bounded edits'), 'edit bound survives')

  // 4. Miss.
  assert.equal(await adapter.load('evolution:nope'), undefined)
  assert.equal(await adapter.load('design:interface-review'), undefined)

  console.log('SKILL EVOLUTION TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
