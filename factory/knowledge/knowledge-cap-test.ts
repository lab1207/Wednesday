import assert from 'node:assert/strict'

import { KnowledgeBuilder } from './knowledge-builder'
import type { DshSkillAdapter } from './dsh-skill-adapter'

function fakeAdapter(contents: string[]): DshSkillAdapter {
  let index = 0
  return {
    async list() {
      return contents.map((_, i) => ({
        name: `skill-${i}`,
        description: `skill ${i}`,
        invocation: { modelInvocable: true },
      }))
    },
    async load(name: string) {
      const i = Number(name.split('-')[1])
      if (!Number.isInteger(i) || contents[i] === undefined) return undefined
      return {
        name,
        description: `skill ${i}`,
        source: 'test',
        provider: 'test',
        content: contents[i],
      }
    },
  } as unknown as DshSkillAdapter
}

async function main(): Promise<void> {
  // Small payload passes through untouched.
  {
    const builder = new KnowledgeBuilder(fakeAdapter(['hello']))
    const knowledge = await builder.build({ objective: 'skill-0 hello' })
    assert.ok(knowledge.rendered.includes('hello'))
    assert.ok(!knowledge.rendered.includes('[truncated'))
    assert.equal(knowledge.skills.length, 1)
  }

  // Large payload is capped at the default (6000) with a marker.
  {
    const builder = new KnowledgeBuilder(fakeAdapter(['x'.repeat(9000)]))
    const knowledge = await builder.build({ objective: 'skill-0' })
    assert.ok(knowledge.rendered.includes('[truncated'))
    assert.ok(knowledge.rendered.length < 9000 + 500)
    assert.equal(knowledge.skills.length, 1)
  }

  // Custom maxChars is honored.
  {
    const builder = new KnowledgeBuilder(fakeAdapter(['y'.repeat(500)]))
    const knowledge = await builder.build({ objective: 'skill-0', maxChars: 100 })
    assert.ok(knowledge.rendered.includes('[truncated'))
    assert.ok(knowledge.rendered.length < 300)
  }

  console.log('KNOWLEDGE CAP TEST: PASS (passthrough, default cap, custom cap)')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
