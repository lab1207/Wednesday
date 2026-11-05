/**
 * Offline test for the verification/memory doctrine adapter. Static
 * content proves list/load shape, caps, trigger hygiene (no tracker/
 * interview/HITL machinery), and miss behavior.
 */
import assert from 'node:assert/strict'

import { RepowiseSkillAdapter, REPOWISE_SKILL_PREFIX } from './repowise-skills'

async function main(): Promise<void> {
  const adapter = new RepowiseSkillAdapter()

  // 1. Catalog: two skills, prefixed, documented, model-invocable.
  const listed = await adapter.list()
  assert.deepEqual(
    listed.map(skill => skill.name),
    [`${REPOWISE_SKILL_PREFIX}verify-ladder`, `${REPOWISE_SKILL_PREFIX}memory-model`],
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
    assert.equal(loaded.source, 'repowise-distilled')
    assert.equal(loaded.provider, 'repowise')
  }

  // 3. Trigger hygiene: doctrine only — no foreign workflow machinery.
  const bodies = await Promise.all(listed.map(skill => adapter.load(skill.name)))
  const joined = bodies.map(loaded => loaded?.content ?? '').join('\n')
  for (const leaked of ['AskUserQuestion', 'HITL', 'Linear', 'Jira', 'MCP', 'sub-agent', 'issue tracker']) {
    assert.ok(
      !joined.includes(leaked),
      `distilled content must stay headless: ${leaked}`,
    )
  }
  assert.ok(joined.includes('cheap→broad') || joined.includes('cheap'), 'ladder core survives')
  assert.ok(joined.includes('OPEN QUESTIONS') || joined.includes('Open questions'), 'memory core survives')

  // 4. Miss: unknown names (and other prefixes) return undefined.
  assert.equal(await adapter.load('repowise:nope'), undefined)
  assert.equal(await adapter.load('pocock:tdd'), undefined)

  console.log('REPOWISE SKILLS TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
