/**
 * Offline test for the OpenDesign doctrine adapter. Static distilled
 * content proves list/load shape, caps, trigger hygiene (no app
 * runtime: launchers, Docker, cloud, MCP, browser), and miss behavior.
 */
import assert from 'node:assert/strict'

import { OdesignSkillAdapter, ODESIGN_SKILL_PREFIX } from './odesign-skills'

async function main(): Promise<void> {
  const adapter = new OdesignSkillAdapter()

  // 1. Catalog: five skills, prefixed, documented, model-invocable.
  const listed = await adapter.list()
  assert.deepEqual(
    listed.map(skill => skill.name),
    [`${ODESIGN_SKILL_PREFIX}design-brief`, `${ODESIGN_SKILL_PREFIX}frontend-design`, `${ODESIGN_SKILL_PREFIX}login-flow`, `${ODESIGN_SKILL_PREFIX}mockup-fidelity`, `${ODESIGN_SKILL_PREFIX}screenshot-critique`],
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
    assert.equal(loaded.source, 'odesign-distilled')
    assert.equal(loaded.provider, 'odesign')
  }

  // 3. Trigger hygiene: doctrine only — no app/CLI runtime leaked in.
  const bodies = await Promise.all(listed.map(skill => adapter.load(skill.name)))
  const joined = bodies.map(loaded => loaded?.content ?? '').join('\n')
  for (const leaked of ['Docker', 'MCP', 'gstack-skill', 'AskUserQuestion', 'cloud CLI', 'desktop app', 'od mcp', 'generate the design image', 'image generation is mandatory']) {
    assert.ok(
      !joined.includes(leaked),
      `distilled content must not carry app runtime or unexecutable mandates: ${leaked}`,
    )
  }
  assert.ok(joined.includes('8 dimensions') || joined.includes('dimensions'), 'brief core survives')
  assert.ok(joined.includes('SELF-REVIEW') || joined.includes('Self-review'), 'build gate survives')

  // 4. Miss: unknown names (and other prefixes) return undefined.
  assert.equal(await adapter.load('odesign:nope'), undefined)
  assert.equal(await adapter.load('gstack:review'), undefined)

  console.log('ODESIGN SKILLS TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
