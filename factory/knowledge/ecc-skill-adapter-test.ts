/**
 * Offline test for the ECC skills-direct adapter. No network, no model:
 * frontmatter parse (multi-line description), catalog listing, single load
 * with cap, composite merge/dedupe/routing, traversal guard, silent absence.
 */
import assert from 'node:assert/strict'

import {
  CompositeSkillSource,
  defaultEccSkillsHome,
  EccSkillAdapter,
  ECC_SKILL_PREFIX,
  parseSkillFile,
} from './ecc-skill-adapter'

async function main(): Promise<void> {
  // 1. Frontmatter: multi-line description joins, body after second fence.
  const parsed = parseSkillFile(
    '---\nname: demo\ndescription: First line.\n  second line.\nmetadata:\n  origin: ECC\n---\n\n# Body\n- a\n',
  )
  if (!parsed) throw new Error('frontmatter must parse')
  assert.equal(parsed.name, 'demo')
  assert.ok(parsed.description.includes('First line.'), 'multi-line description joins')
  assert.ok(parsed.description.includes('second line.'))
  assert.ok(parsed.body.includes('# Body'))
  assert.equal(parseSkillFile('no fence'), null)
  assert.equal(parseSkillFile('---\ndescription: noname\n---\nbody'), null)

  // 2. Real checkout (only when present): full catalog lists.
  const adapter = new EccSkillAdapter()
  const listed = await adapter.list()
  if (listed.length > 0) {
    assert.ok(listed.length >= 200, `expected the ECC catalog, got ${listed.length}`)
    assert.ok(listed.every(skill => skill.name.startsWith(ECC_SKILL_PREFIX)))
    assert.ok(listed.every(skill => skill.invocation.modelInvocable === true))
    console.log(`  real checkout: ${listed.length} skills`)

    // 3. Single load: capped content, routed metadata.
    const loaded = await adapter.load(`${ECC_SKILL_PREFIX}accessibility`)
    if (!loaded) throw new Error('accessibility must load')
    assert.equal(loaded.source, 'ecc-skills')
    assert.equal(loaded.provider, 'ecc')
    assert.ok(loaded.content.length <= 2200, 'content capped')
    assert.ok((loaded.whenToUse ?? '').length > 0, 'when-to-use extracted')

    // 4. Unknown + traversal guarded.
    assert.equal(await adapter.load(`${ECC_SKILL_PREFIX}nope`), undefined)
    assert.equal(await adapter.load(`${ECC_SKILL_PREFIX}../agents`), undefined)
    assert.equal(await adapter.load('plain-name'), undefined)
  } else {
    const missing = new EccSkillAdapter('/nonexistent-dir-xyz')
    assert.deepEqual(await missing.list(), [])
    assert.equal(await missing.load(`${ECC_SKILL_PREFIX}x`), undefined)
  }

  // 5. Composite: DSH first, ECC appended, dedupe, routing (fake sources).
  const fake = (names: string[], prefix = '') => ({
    async list() {
      return names.map(name => ({
        name: `${prefix}${name}`,
        description: `${name} desc`,
        invocation: { modelInvocable: true, userInvocable: true },
      }))
    },
    async load(name: string) {
      const base = name.startsWith(prefix) ? name : `${prefix}${name}`
      if (!names.includes(name.replace(prefix, ''))) return undefined
      return { name: base, description: 'd', source: 't', provider: 't', content: base }
    },
  })
  const composite = new CompositeSkillSource(fake(['a', 'dup']), fake(['b', 'dup'], ECC_SKILL_PREFIX))
  const merged = await composite.list()
  assert.deepEqual(merged.map(skill => skill.name), ['a', 'dup', `${ECC_SKILL_PREFIX}b`, `${ECC_SKILL_PREFIX}dup`])
  assert.equal((await composite.load(`${ECC_SKILL_PREFIX}b`))?.content, `${ECC_SKILL_PREFIX}b`)
  assert.equal((await composite.load('a'))?.content, 'a')

  // 6. Default home points at the checkout (even when absent here).
  assert.ok(defaultEccSkillsHome().endsWith('ecc-source/skills'.replace('/', '\\')) || defaultEccSkillsHome().endsWith('ecc-source/skills'))

  // 7. Composite through the REAL builder: ECC playbook surfaces in prompts.
  const { KnowledgeBuilder } = await import('./knowledge-builder')
  const { SkillSelector } = await import('./skill-selector')
  const emptyDsh = {
    async list() {
      return []
    },
    async load() {
      return undefined
    },
  }
  const compositeBuilder = new KnowledgeBuilder(
    new CompositeSkillSource(emptyDsh, new EccSkillAdapter()),
    new SkillSelector(),
  )
  const knowledge = await compositeBuilder.build({
    objective: 'Audit this UI for WCAG keyboard contrast screen-reader support',
    maxSkills: 3,
  })
  const names = knowledge.skills.map(skill => skill.name)
  assert.ok(names.some(name => name.startsWith(ECC_SKILL_PREFIX)), `ECC skill must rank, got ${names}`)
  assert.ok(knowledge.rendered.includes('<factory_skill name="ecc:'), 'rendered prompt carries ECC content')

  console.log('ECC SKILL ADAPTER TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
