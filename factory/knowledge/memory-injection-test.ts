/**
 * Offline test for the workspace memory in the KNOWLEDGE PATH: the writer
 * that records what a run taught, and the builder that always injects it.
 * No network.
 *
 * The gap this closes (2026-11-05): the knowledge layer was twenty adapters
 * of STATIC doctrine - the same card for every workspace, every run - so the
 * factory forgot everything between runs and re-derived the same test
 * command every time. The memory is the workspace's own facts, and it is
 * injected ALWAYS rather than through the relevance selector (a selector
 * that only picked it when the request happened to contain the word
 * "project" would drop the most useful fact in the room).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// STATE_HOME is captured at import time, so the env var comes FIRST and the
// modules under test are loaded dynamically.
const stateHome = mkdtempSync(join(tmpdir(), 'wednesday-memory-'))
process.env.WEDNESDAY_STATE_HOME = stateHome

async function main(): Promise<void> {
  const { rememberRunOutcome, loadProjectMemory, renderProjectMemory } =
    await import('./project-memory')
  const { KnowledgeBuilder } = await import('./knowledge-builder')
  const { ProjectMemoryAdapter } = await import('./project-memory')
  type Selectable = { name: string; description: string; whenToUse?: string; invocation: { modelInvocable: boolean } }
  type Skill = { name: string; description: string; whenToUse?: string; source: string; provider: string; content: string }
  const emptySource = {
    async list(): Promise<Selectable[]> { return [] },
    async load(): Promise<Skill | undefined> { return undefined },
  }

  const workspace = join(stateHome, 'demo-workspace')

  try {
    // 1. A finished run teaches the factory the command that PASSED.
    rememberRunOutcome(workspace, {
      testCommand: 'npm test',
      summary: 'built the thing',
    })
    const memory = loadProjectMemory(workspace)
    assert.equal(memory.facts.length, 2)
    assert.ok(memory.facts.some(f => f.key === 'test command' && f.value === 'npm test'))
    assert.ok(memory.facts.some(f => f.key === 'last build' && f.value === 'built the thing'))

    // 2. The same run twice does not double the facts.
    rememberRunOutcome(workspace, { testCommand: 'npm test', summary: 'built it again' })
    assert.equal(loadProjectMemory(workspace).facts.length, 2, 'the facts are upserted, not appended')
    assert.ok(
      loadProjectMemory(workspace).facts.some(f => f.value === 'built it again'),
      'the newer value wins',
    )

    // 3. A long summary is trimmed: a memory is a fact, not a transcript.
    rememberRunOutcome(workspace, { summary: 'x'.repeat(500) })
    const summaryFact = loadProjectMemory(workspace).facts.find(f => f.key === 'last build')
    assert.ok(summaryFact)
    assert.ok(summaryFact!.value.length <= 200, 'the summary is trimmed')

    // 4. THE BUILDER INJECTS IT. A workspace with facts always carries them.
    const builder = new KnowledgeBuilder(emptySource)
    const context = await builder.build({
      objective: 'do the thing',
      workspace,
    })
    assert.ok(
      context.rendered.includes('PROJECT MEMORY'),
      'the memory is in the rendered context',
    )
    assert.ok(
      context.rendered.includes('npm test'),
      'the learned test command reaches the model',
    )
    assert.ok(
      context.skills.some(skill => skill.name === 'project:memory'),
      'the memory is a skill of the context, not a hidden string',
    )

    // 5. A workspace with NOTHING learned injects NOTHING. An empty memory
    //    is noise, and noise costs a small model's window.
    const blank = join(stateHome, 'blank-workspace')
    const blankContext = await builder.build({
      objective: 'do the thing',
      workspace: blank,
    })
    assert.ok(
      !blankContext.rendered.includes('PROJECT MEMORY'),
      'a workspace that learned nothing carries no memory block',
    )
    assert.equal(blankContext.skills.length, 0)

    // 6. THE ADAPTER HONOURS THE WORKSPACE. It used to render `process.cwd()`
    //    and ignore the query's workspace, so a run in another directory was
    //    told the facts of wherever the process happened to start.
    const adapter = new ProjectMemoryAdapter()
    const loaded = await adapter.load('project:memory', workspace)
    assert.ok(loaded, 'the memory loads')
    assert.ok(loaded!.content.includes('npm test'), 'the named workspace is the one rendered')
    const other = await adapter.load('project:memory', blank)
    assert.ok(other)
    assert.ok(
      !other!.content.includes('npm test'),
      'another workspace does not inherit this one facts',
    )
    assert.equal(await adapter.load('something-else'), undefined, 'a miss returns undefined')

    // 7. The rendered block says when it has to cut.
    const rendered = renderProjectMemory(workspace, 40)
    assert.ok(rendered.length <= 40)
    assert.ok(/truncated|cut|\.\.\./.test(rendered), 'a cut block says so')

    console.log('memory-injection: PASS')
  } finally {
    rmSync(stateHome, { recursive: true, force: true })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
