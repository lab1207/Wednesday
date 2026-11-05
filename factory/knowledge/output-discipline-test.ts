/**
 * Offline test for the output-discipline adapter. Static content proves
 * the single-card shape, cap, trigger hygiene (no installer/tracker
 * machinery), and miss behavior.
 */
import assert from 'node:assert/strict'

import { OutputDisciplineAdapter, OUTPUT_DISCIPLINE_PREFIX } from './output-discipline'

async function main(): Promise<void> {
  const adapter = new OutputDisciplineAdapter()

  // 1. Catalog: one card, documented, model-invocable.
  const listed = await adapter.list()
  assert.deepEqual(
    listed.map(skill => skill.name),
    [`${OUTPUT_DISCIPLINE_PREFIX}output-discipline`],
  )
  assert.ok(listed[0].description.length > 20)
  assert.ok((listed[0].whenToUse ?? '').length > 20)
  assert.equal(listed[0].invocation.modelInvocable, true)

  // 2. Load: content present, capped, sourced.
  const loaded = await adapter.load(`${OUTPUT_DISCIPLINE_PREFIX}output-discipline`)
  assert.ok(loaded)
  assert.ok(loaded.content.length > 200)
  assert.ok(loaded.content.length <= 2000, `cap holds, got ${loaded.content.length}`)
  assert.equal(loaded.source, 'adhd-distilled')
  assert.equal(loaded.provider, 'adhd')

  // 3. Hygiene: doctrine only — no install/tracker machinery.
  for (const leaked of ['npx skills', 'plugin install', 'marketplace', 'newsletter', 'Discord']) {
    assert.ok(
      !loaded.content.includes(leaked),
      `distilled content must not carry install machinery: ${leaked}`,
    )
  }
  assert.ok(loaded.content.includes('next action'), 'action-first core survives')

  // 4. Miss.
  assert.equal(await adapter.load('style:nope'), undefined)
  assert.equal(await adapter.load('safety:skill-vetting'), undefined)

  console.log('OUTPUT DISCIPLINE TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
