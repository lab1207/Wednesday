/**
 * Offline test for the impeccable context adapter. Static content proves
 * the single-card shape, cap, tooling hygiene (no CLI/command
 * machinery), and miss behavior.
 */
import assert from 'node:assert/strict'

import { ImpeccableAdapter, IMPECCABLE_PREFIX } from './impeccable-context'

async function main(): Promise<void> {
  const adapter = new ImpeccableAdapter()

  // 1. Catalog: one card, documented, model-invocable.
  const listed = await adapter.list()
  assert.deepEqual(
    listed.map(skill => skill.name),
    [`${IMPECCABLE_PREFIX}durable-context`],
  )
  assert.ok(listed[0].description.length > 20)
  assert.ok((listed[0].whenToUse ?? '').length > 20)
  assert.equal(listed[0].invocation.modelInvocable, true)

  // 2. Load: content present, capped, sourced.
  const loaded = await adapter.load(`${IMPECCABLE_PREFIX}durable-context`)
  assert.ok(loaded)
  assert.ok(loaded.content.length > 200)
  assert.ok(loaded.content.length <= 2000, `cap holds, got ${loaded.content.length}`)
  assert.equal(loaded.source, 'impeccable-distilled')
  assert.equal(loaded.provider, 'pbakaus')

  // 3. Hygiene: doctrine only — no CLI/command machinery.
  for (const leaked of ['npx impeccable', '/impeccable ', '/impeccable init', 'PRODUCT.md', 'DESIGN.md', 'detector']) {
    assert.ok(
      !loaded.content.includes(leaked),
      `distilled content must not carry tooling machinery: ${leaked}`,
    )
  }
  assert.ok(loaded.content.includes('durable product truth'), 'record-once survives')
  assert.ok(loaded.content.includes('per surface'), 'truth/direction split survives')

  // 4. Miss.
  assert.equal(await adapter.load('impeccable:nope'), undefined)
  assert.equal(await adapter.load('design:interface-review'), undefined)

  console.log('IMPECCABLE CONTEXT TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
