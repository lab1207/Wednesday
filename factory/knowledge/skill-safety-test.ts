/**
 * Offline test for the skill-safety adapter. Static content proves the
 * single-card shape, cap, trigger hygiene (no tool install/run
 * machinery), and miss behavior.
 */
import assert from 'node:assert/strict'

import { SkillSafetyAdapter, SKILL_SAFETY_PREFIX } from './skill-safety'

async function main(): Promise<void> {
  const adapter = new SkillSafetyAdapter()

  // 1. Catalog: one card, documented, model-invocable.
  const listed = await adapter.list()
  assert.deepEqual(
    listed.map(skill => skill.name),
    [`${SKILL_SAFETY_PREFIX}skill-vetting`],
  )
  assert.ok(listed[0].description.length > 20)
  assert.ok((listed[0].whenToUse ?? '').length > 20)
  assert.equal(listed[0].invocation.modelInvocable, true)

  // 2. Load: content present, capped, sourced.
  const loaded = await adapter.load(`${SKILL_SAFETY_PREFIX}skill-vetting`)
  assert.ok(loaded)
  assert.ok(loaded.content.length > 200)
  assert.ok(loaded.content.length <= 2000, `cap holds, got ${loaded.content.length}`)
  assert.equal(loaded.source, 'skillspector-distilled')
  assert.equal(loaded.provider, 'skillspector')

  // 3. Hygiene: doctrine only — no scanner install/run machinery.
  for (const leaked of ['uv tool install', 'pip install', 'docker run', 'API_KEY', 'MCP server']) {
    assert.ok(
      !loaded.content.includes(leaked),
      `distilled content must not carry tool machinery: ${leaked}`,
    )
  }
  assert.ok(loaded.content.includes('quarantine'), 'verdict rule survives')

  // 4. Miss.
  assert.equal(await adapter.load('safety:nope'), undefined)
  assert.equal(await adapter.load('pocock:tdd'), undefined)

  console.log('SKILL SAFETY TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
