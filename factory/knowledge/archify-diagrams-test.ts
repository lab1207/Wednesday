/**
 * Offline test for the archify diagrams adapter. Static content proves
 * the single-card shape, cap, renderer hygiene (no schema/toolchain
 * machinery), and miss behavior.
 */
import assert from 'node:assert/strict'

import { ArchifyAdapter, ARCHIFY_PREFIX } from './archify-diagrams'

async function main(): Promise<void> {
  const adapter = new ArchifyAdapter()

  // 1. Catalog: one card, documented, model-invocable.
  const listed = await adapter.list()
  assert.deepEqual(
    listed.map(skill => skill.name),
    [`${ARCHIFY_PREFIX}evidence-diagrams`],
  )
  assert.ok(listed[0].description.length > 20)
  assert.ok((listed[0].whenToUse ?? '').length > 20)
  assert.equal(listed[0].invocation.modelInvocable, true)

  // 2. Load: content present, capped, sourced.
  const loaded = await adapter.load(`${ARCHIFY_PREFIX}evidence-diagrams`)
  assert.ok(loaded)
  assert.ok(loaded.content.length > 200)
  assert.ok(loaded.content.length <= 2000, `cap holds, got ${loaded.content.length}`)
  assert.equal(loaded.source, 'archify-distilled')
  assert.equal(loaded.provider, 'tt-a1i')

  // 3. Hygiene: doctrine only — no renderer/toolchain machinery.
  for (const leaked of ['archify.mjs', 'schema_version', 'inline SVG', 'PNG/JPEG', 'Mermaid']) {
    assert.ok(
      !loaded.content.includes(leaked),
      `distilled content must not carry renderer machinery: ${leaked}`,
    )
  }
  assert.ok(loaded.content.includes('Evidence grounding'), 'grounding survives')
  assert.ok(loaded.content.includes('Validate after every edit'), 'validate gate survives')

  // 4. Miss.
  assert.equal(await adapter.load('archify:nope'), undefined)
  assert.equal(await adapter.load('meta:skill-authoring'), undefined)

  console.log('ARCHIFY DIAGRAMS TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
