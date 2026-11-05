/**
 * Offline test for the addy quality adapter. Static content proves the
 * two-card shape, caps, engine hygiene (no lifecycle-pack machinery),
 * and miss behavior.
 */
import assert from 'node:assert/strict'

import { AddyQualityAdapter, ADDY_QUALITY_PREFIX } from './addy-quality'

async function main(): Promise<void> {
  const adapter = new AddyQualityAdapter()

  // 1. Catalog: two cards, documented, model-invocable.
  const listed = await adapter.list()
  assert.deepEqual(
    listed.map(skill => skill.name),
    [`${ADDY_QUALITY_PREFIX}doubt-driven`, `${ADDY_QUALITY_PREFIX}constraint-driven`],
  )
  for (const skill of listed) {
    assert.ok(skill.description.length > 20)
    assert.ok((skill.whenToUse ?? '').length > 20)
    assert.equal(skill.invocation.modelInvocable, true)
  }

  // 2. Load: contents present, capped, sourced.
  for (const name of [`${ADDY_QUALITY_PREFIX}doubt-driven`, `${ADDY_QUALITY_PREFIX}constraint-driven`]) {
    const loaded = await adapter.load(name)
    assert.ok(loaded)
    assert.ok(loaded.content.length > 200)
    assert.ok(loaded.content.length <= 2000, `cap holds for ${name}, got ${loaded.content.length}`)
    assert.equal(loaded.source, 'addy-distilled')
    assert.equal(loaded.provider, 'addyosmani')
  }

  // 3. Hygiene: doctrine only — no lifecycle-pack machinery.
  const doubt = await adapter.load(`${ADDY_QUALITY_PREFIX}doubt-driven`)
  const constraints = await adapter.load(`${ADDY_QUALITY_PREFIX}constraint-driven`)
  for (const leaked of ['npx skills add', '/spec', '/build auto', 'CONSTRAINTS.md']) {
    assert.ok(
      !doubt!.content.includes(leaked) && !constraints!.content.includes(leaked),
      `distilled content must not carry pack machinery: ${leaked}`,
    )
  }
  assert.ok(doubt!.content.includes('DISPROVE'), 'disprove bias survives')
  assert.ok(constraints!.content.includes('weakened bar'), 'diff-watch survives')

  // 4. Miss.
  assert.equal(await adapter.load('addy:nope'), undefined)
  assert.equal(await adapter.load('pocock:tdd'), undefined)

  console.log('ADDY QUALITY TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
