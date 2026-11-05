/**
 * Offline test for the skill-authoring adapter. Static content proves
 * the single-card shape, cap, harness hygiene (no eval-runner
 * machinery), and miss behavior.
 */
import assert from 'node:assert/strict'

import { SkillAuthoringAdapter, SKILL_AUTHORING_PREFIX } from './skill-authoring'

async function main(): Promise<void> {
  const adapter = new SkillAuthoringAdapter()

  // 1. Catalog: one card, documented, model-invocable.
  const listed = await adapter.list()
  assert.deepEqual(
    listed.map(skill => skill.name),
    [`${SKILL_AUTHORING_PREFIX}skill-authoring`],
  )
  assert.ok(listed[0].description.length > 20)
  assert.ok((listed[0].whenToUse ?? '').length > 20)
  assert.equal(listed[0].invocation.modelInvocable, true)

  // 2. Load: content present, capped, sourced.
  const loaded = await adapter.load(`${SKILL_AUTHORING_PREFIX}skill-authoring`)
  assert.ok(loaded)
  assert.ok(loaded.content.length > 200)
  assert.ok(loaded.content.length <= 2000, `cap holds, got ${loaded.content.length}`)
  assert.equal(loaded.source, 'anthropics-distilled')
  assert.equal(loaded.provider, 'anthropics')

  // 3. Hygiene: doctrine only — no eval-harness machinery.
  for (const leaked of ['eval-viewer', 'generate_review', 'claude-with-access', 'variance analysis']) {
    assert.ok(
      !loaded.content.includes(leaked),
      `distilled content must not carry harness machinery: ${leaked}`,
    )
  }
  assert.ok(loaded.content.includes('trigger'), 'trigger discipline survives')
  assert.ok(loaded.content.includes('evolution:skill-evolution'), 'evolution pairing survives')

  // 4. Miss.
  assert.equal(await adapter.load('meta:nope'), undefined)
  assert.equal(await adapter.load('evolution:skill-evolution'), undefined)

  console.log('SKILL AUTHORING TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
