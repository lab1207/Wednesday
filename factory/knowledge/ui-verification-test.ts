/**
 * Offline test for the DOM-first UI verification adapter. Static content
 * proves the single-card shape, cap, trigger hygiene (no extension/MCP/
 * install machinery), and miss behavior.
 */
import assert from 'node:assert/strict'

import { UiVerifyAdapter, UI_VERIFY_PREFIX } from './ui-verification'

async function main(): Promise<void> {
  const adapter = new UiVerifyAdapter()

  // 1. Catalog: one card, documented, model-invocable.
  const listed = await adapter.list()
  assert.deepEqual(
    listed.map(skill => skill.name),
    [`${UI_VERIFY_PREFIX}dom-verification`],
  )
  assert.ok(listed[0].description.length > 20)
  assert.ok((listed[0].whenToUse ?? '').length > 20)
  assert.equal(listed[0].invocation.modelInvocable, true)

  // 2. Load: content present, capped, sourced.
  const loaded = await adapter.load(`${UI_VERIFY_PREFIX}dom-verification`)
  assert.ok(loaded)
  assert.ok(loaded.content.length > 200)
  assert.ok(loaded.content.length <= 2000, `cap holds, got ${loaded.content.length}`)
  assert.equal(loaded.source, 'pageagent-distilled')
  assert.equal(loaded.provider, 'pageagent')

  // 3. Hygiene: doctrine only — no product/install machinery.
  for (const leaked of ['Chrome extension', 'npm install', 'MCP server', 'API_KEY', 'copilot']) {
    assert.ok(
      !loaded.content.includes(leaked),
      `distilled content must not carry product machinery: ${leaked}`,
    )
  }
  assert.ok(loaded.content.includes('DOM'), 'DOM-first core survives')

  // 4. Miss.
  assert.equal(await adapter.load('ui:nope'), undefined)
  assert.equal(await adapter.load('style:output-discipline'), undefined)

  console.log('UI VERIFICATION TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
