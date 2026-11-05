/**
 * Offline test for the DDG search-recipe builtin skill. No network, no
 * model: lite URL encoding, uddg extraction (amp-unescape + decode +
 * http-only + cap), adapter roundtrip, selector ranking, builder render.
 */
import assert from 'node:assert/strict'

import {
  BuiltinSkillAdapter,
  buildDdgLiteUrl,
  DDG_SKILL_NAME,
  extractDdgTargets,
} from './builtin-skills'

import { KnowledgeBuilder } from './knowledge-builder'
import { SkillSelector } from './skill-selector'

async function main(): Promise<void> {
  // 1. Lite URL encodes the query.
  assert.equal(
    buildDdgLiteUrl('stripe webhooks api'),
    'https://lite.duckduckgo.com/lite/?q=stripe%20webhooks%20api',
  )
  assert.ok(
    buildDdgLiteUrl('a&b').includes('a%26b'),
    'ampersand must encode',
  )

  // 2. uddg extraction: amp-unescape, decode, http-only, dedupe, cap.
  const html = [
    '<a href="/l/?kh=-1&amp;uddg=https%3A%2F%2Fstripe.com%2Fdocs%2Fwebhooks">one</a>',
    '<a href="/l/?kh=-1&uddg=https%3A%2F%2Fexample.com%2Fa+b">two</a>',
    '<a href="/l/?kh=-1&amp;uddg=https%3A%2F%2Fstripe.com%2Fdocs%2Fwebhooks">dup</a>',
    '<a href="/l/?kh=-1&amp;uddg=javascript%3Aalert(1)">bad</a>',
    '<a href="/plain">no uddg</a>',
  ].join('\n')
  assert.deepEqual(extractDdgTargets(html), [
    'https://stripe.com/docs/webhooks',
    'https://example.com/a b',
  ])
  const many = Array.from(
    { length: 15 },
    (_, i) =>
      `<a href="/l/?uddg=https%3A%2F%2Fexample.com%2F${i}">x</a>`,
  ).join('')
  assert.equal(extractDdgTargets(many).length, 10, 'targets cap at 10')
  assert.equal(extractDdgTargets(many, 3).length, 3, 'custom limit honored')
  assert.deepEqual(extractDdgTargets('no links here'), [])

  // 3. Adapter roundtrip: one skill, exact recipe content, unknown guarded.
  const adapter = new BuiltinSkillAdapter()
  const listed = await adapter.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, DDG_SKILL_NAME)
  assert.equal(listed[0].invocation.modelInvocable, true)
  const loaded = await adapter.load(DDG_SKILL_NAME)
  if (!loaded) throw new Error('builtin skill must load')
  assert.equal(loaded.source, 'factory-builtin')
  assert.equal(loaded.provider, 'factory')
  assert.ok(
    loaded.content.includes('lite.duckduckgo.com/lite/?q='),
    'recipe must teach the lite fetch',
  )
  assert.ok(
    loaded.content.includes('uddg'),
    'recipe must teach uddg decode',
  )
  assert.ok(
    loaded.content.includes('GET only'),
    'recipe must carry mechanical caps',
  )
  assert.equal(await adapter.load('nope'), undefined)

  // 4. Selector ranks it for a research task (score >= 8 gate).
  const selector = new SkillSelector()
  const picked = selector.select(listed, {
    objective: 'Research the Stripe API docs for webhook errors',
    role: 'coder',
    stack: 'typescript',
  })
  assert.ok(
    picked.some(entry => entry.skill.name === DDG_SKILL_NAME),
    `recipe must rank for research, got ${picked.map(e => e.skill.name)}`,
  )

  // 5. Builder renders it into the prompt (capped downstream as usual).
  const builder = new KnowledgeBuilder(adapter, selector)
  const knowledge = await builder.build({
    objective: 'Research the Stripe API docs for webhook errors',
    role: 'coder',
    stack: 'typescript',
    maxSkills: 3,
  })
  assert.ok(
    knowledge.skills.some(skill => skill.name === DDG_SKILL_NAME),
    'builder must surface the recipe',
  )
  assert.ok(
    knowledge.rendered.includes('<factory_skill name="factory:ddg-search-recipe">'),
    'rendered prompt must carry the recipe',
  )

  console.log('BUILTIN SKILLS TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
