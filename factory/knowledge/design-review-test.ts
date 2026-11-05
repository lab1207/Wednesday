/**
 * Offline test for the interface-review doctrine adapter. Static content
 * proves the single-card shape, cap, trigger hygiene (no install/vendor
 * machinery), and miss behavior.
 */
import assert from 'node:assert/strict'

import { DesignReviewAdapter, DESIGN_REVIEW_PREFIX } from './design-review'

async function main(): Promise<void> {
  const adapter = new DesignReviewAdapter()

  // 1. Catalog: one card, documented, model-invocable.
  const listed = await adapter.list()
  assert.deepEqual(
    listed.map(skill => skill.name),
    [`${DESIGN_REVIEW_PREFIX}interface-review`],
  )
  assert.ok(listed[0].description.length > 20)
  assert.ok((listed[0].whenToUse ?? '').length > 20)
  assert.equal(listed[0].invocation.modelInvocable, true)

  // 2. Load: content present, capped, sourced.
  const loaded = await adapter.load(`${DESIGN_REVIEW_PREFIX}interface-review`)
  assert.ok(loaded)
  assert.ok(loaded.content.length > 200)
  assert.ok(loaded.content.length <= 2000, `cap holds, got ${loaded.content.length}`)
  assert.equal(loaded.source, 'krehel-distilled')
  assert.equal(loaded.provider, 'krehel')

  // 3. Hygiene: doctrine only — no install/vendor machinery.
  for (const leaked of ['npx skills', 'plugin install', 'marketplace', 'npm install', 'symlink']) {
    assert.ok(
      !loaded.content.includes(leaked),
      `distilled content must not carry install machinery: ${leaked}`,
    )
  }
  assert.ok(loaded.content.includes('HIGH on sight'), 'trigger ladder survives')
  assert.ok(loaded.content.includes('Cheaper fix first') || loaded.content.includes('cheaper'), 'fix ladder survives')

  // 4. Miss.
  assert.equal(await adapter.load('design:nope'), undefined)
  assert.equal(await adapter.load('ui:dom-verification'), undefined)

  console.log('DESIGN REVIEW TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
