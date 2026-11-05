/**
 * Offline test for the gstack doctrine adapter. No network, no checkout:
 * static distilled content proves list/load shape, caps, trigger
 * hygiene (no Claude Code runtime: bins, telemetry, AskUserQuestion
 * machinery), and unknown-name miss.
 */
import assert from 'node:assert/strict'

import { GstackSkillAdapter, GSTACK_SKILL_PREFIX } from './gstack-skills'

async function main(): Promise<void> {
  const adapter = new GstackSkillAdapter()

  // 1. Catalog: three skills, prefixed, documented, model-invocable.
  const listed = await adapter.list()
  assert.deepEqual(
    listed.map(skill => skill.name),
    [`${GSTACK_SKILL_PREFIX}investigate`, `${GSTACK_SKILL_PREFIX}cso`, `${GSTACK_SKILL_PREFIX}review`],
  )
  for (const skill of listed) {
    assert.ok(skill.description.length > 20)
    assert.ok((skill.whenToUse ?? '').length > 20)
    assert.equal(skill.invocation.modelInvocable, true)
  }

  // 2. Load: content present, capped for small-model ceilings, sourced.
  for (const skill of listed) {
    const loaded = await adapter.load(skill.name)
    assert.ok(loaded)
    assert.ok(loaded.content.length > 200)
    assert.ok(loaded.content.length <= 2000, `cap holds, got ${loaded.content.length}`)
    assert.equal(loaded.source, 'gstack-distilled')
    assert.equal(loaded.provider, 'gstack')
  }

  // 3. Trigger hygiene: doctrine only — no Claude Code runtime leaked in.
  const bodies = await Promise.all(listed.map(skill => adapter.load(skill.name)))
  const joined = bodies.map(loaded => loaded?.content ?? '').join('\n')
  for (const leaked of ['AskUserQuestion', 'gstack-skill-start', 'telemetry', '~/.claude', 'Aside', 'gbrain', 'AUQ']) {
    assert.ok(
      !joined.includes(leaked),
      `distilled content must not carry Claude Code runtime: ${leaked}`,
    )
  }
  assert.ok(joined.includes('Iron Law'), 'investigate core survives')
  assert.ok(joined.includes('ATTACKER'), 'cso core survives')
  assert.ok(joined.includes('QUOTE') || joined.includes('quote'), 'review gate survives')

  // 4. Miss: unknown names (and other prefixes) return undefined.
  assert.equal(await adapter.load('gstack:nope'), undefined)
  assert.equal(await adapter.load('ecc:review'), undefined)

  console.log('GSTACK SKILLS TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
