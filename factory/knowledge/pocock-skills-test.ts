/**
 * Offline test for the real-engineering doctrine adapter. Static content
 * proves list/load shape, caps, trigger hygiene (no interview/tracker
 * machinery — headless only), and miss behavior.
 */
import assert from 'node:assert/strict'

import { PocockSkillAdapter, POCOCK_SKILL_PREFIX } from './pocock-skills'

async function main(): Promise<void> {
  const adapter = new PocockSkillAdapter()

  // 1. Catalog: three skills, prefixed, documented, model-invocable.
  const listed = await adapter.list()
  assert.deepEqual(
    listed.map(skill => skill.name),
    [`${POCOCK_SKILL_PREFIX}tdd`, `${POCOCK_SKILL_PREFIX}diagnosing-bugs`, `${POCOCK_SKILL_PREFIX}code-review`],
  )
  for (const skill of listed) {
    assert.ok(skill.description.length > 20)
    assert.ok((skill.whenToUse ?? '').length > 20)
    assert.equal(skill.invocation.modelInvocable, true)
  }

  // 2. Load: content present, capped, sourced.
  for (const skill of listed) {
    const loaded = await adapter.load(skill.name)
    assert.ok(loaded)
    assert.ok(loaded.content.length > 200)
    assert.ok(loaded.content.length <= 2000, `cap holds, got ${loaded.content.length}`)
    assert.equal(loaded.source, 'pocock-distilled')
    assert.equal(loaded.provider, 'pocock')
  }

  // 3. Trigger hygiene: doctrine only — no human-interview/tracker runtime.
  const bodies = await Promise.all(listed.map(skill => adapter.load(skill.name)))
  const joined = bodies.map(loaded => loaded?.content ?? '').join('\n')
  for (const leaked of ['AskUserQuestion', 'grill-me', 'issue tracker', 'Linear', 'CONTEXT.md', 'HITL', 'sub-agent']) {
    assert.ok(
      !joined.includes(leaked),
      `distilled content must stay headless: ${leaked}`,
    )
  }
  assert.ok(joined.includes('Red before green'), 'tdd core survives')
  assert.ok(joined.includes('red-capable'), 'diagnosing core survives')
  assert.ok(joined.includes('two axes') || joined.includes('Two-axis'), 'review core survives')

  // 4. Miss: unknown names (and other prefixes) return undefined.
  assert.equal(await adapter.load('pocock:nope'), undefined)
  assert.equal(await adapter.load('odesign:frontend-design'), undefined)

  console.log('POCOCK SKILLS TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
