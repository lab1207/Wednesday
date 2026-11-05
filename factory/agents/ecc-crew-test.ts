/**
 * Offline test for the ECC specialist crew loader/selector. No network, no
 * model: parses frontmatter, loads the small crew from the real checkout
 * (only when present), selects per task text, renders guidance, stays
 * silent on empty crews.
 */
import assert from 'node:assert/strict'

import {
  buildCrewGuidance,
  listEccCatalog,
  loadEccAgent,
  loadSmallCrew,
  parseEccAgentFile,
  rankCatalog,
  selectCrewForTask,
  SMALL_CREW,
  type EccAgent,
} from './ecc-crew'

const fake = (name: string): EccAgent => ({ name, description: `${name} desc`, body: '## Hi\n- check one\n- check two' })

async function main(): Promise<void> {
  // 1. Frontmatter parse + body cap.
  const parsed = parseEccAgentFile('x.md', '---\nname: x-man\ndescription: Does X.\n---\n\n## Rules\n- a\n- b\n')
  assert.ok(parsed, 'frontmatter must parse')
  assert.equal(parsed.name, 'x-man')
  assert.equal(parsed.description, 'Does X.')
  assert.ok(parsed.body.includes('- a'))
  assert.equal(parseEccAgentFile('x.md', 'no frontmatter'), null)
  const long = parseEccAgentFile('x.md', '---\nname: y\n---\n' + 'z'.repeat(9000))
  assert.ok(long && long.body.length <= 3000, 'body must be capped')

  // 2. Missing agent file is null, never throws.
  assert.equal(await loadEccAgent('/nonexistent-dir-xyz', 'nope'), null)

  // 3. Real checkout (only when present): small crew loads, catalog is big.
  const crew = await loadSmallCrew()
  if (crew.length > 0) {
    const names = crew.map(agent => agent.name)
    for (const want of SMALL_CREW) {
      assert.ok(names.includes(want), `small crew missing ${want}`)
    }
    const catalog = await listEccCatalog()
    assert.ok(catalog.length >= 60, `expected the full ECC catalog, got ${catalog.length}`)
    console.log(`  real checkout: crew ${crew.length}, catalog ${catalog.length}`)

    // 4. Selection: python bugfix with auth → full relevant crew.
    const picked = selectCrewForTask(crew, {
      objective: 'Fix the login bug: auth tokens leak on failed password retry',
      stack: 'python',
    }).map(agent => agent.name)
    assert.ok(picked.includes('code-reviewer'), 'spine always selected')
    assert.ok(picked.includes('python-reviewer'), 'stack specialist selected')
    assert.ok(picked.includes('security-reviewer'), 'sensitivity specialist selected')
    assert.ok(picked.includes('silent-failure-hunter'), 'fix-loop specialist selected')

    // 4b. Repair-adjacent routing: build breaks pull the resolver, test
    // language pulls the TDD guide. Narrow keywords only.
    const buildPicked = selectCrewForTask(crew, {
      objective: 'Build fails: tsc reports type error, cannot find module',
      stack: 'typescript',
    }).map(agent => agent.name)
    assert.ok(buildPicked.includes('build-error-resolver'), 'build break must route to the resolver')
    const testPicked = selectCrewForTask(crew, {
      objective: 'Write verification for the new endpoint, coverage must pass',
      stack: 'python',
    }).map(agent => agent.name)
    assert.ok(testPicked.includes('tdd-guide'), 'test work must route to the TDD guide')

    // 5. Plain task → spine only.
    const plain = selectCrewForTask(crew, { objective: 'Write docs', stack: 'markdown' })
    assert.deepEqual(plain.map(agent => agent.name), ['code-reviewer'])

    // 6. Guidance renders checklists, silent when empty.
    const guidance = buildCrewGuidance(selectCrewForTask(crew, { objective: 'Fix python bug', stack: 'python' }))
    assert.ok(guidance.includes('## Specialist review checklist'))
    assert.ok(guidance.includes('### Specialist: python-reviewer'))
    assert.equal(buildCrewGuidance([]), '')

    // 7. Difficulty cap: maxAgents bounds the pick (low band → 5, floor 1).
    const capped = selectCrewForTask(crew, { objective: 'Fix auth python bug', stack: 'python' }, 2)
    assert.equal(capped.length, 2, 'band cap must bound selection')
    assert.equal(capped[0].name, 'code-reviewer', 'spine stays first under a cap')

    // 8. Catalog ranking: python auth task surfaces the right specialists first.
    // Top-4 (not top-3): the expanded 6-crew ranks tdd-guide 2nd on the
    // word "fix" via its fix->debug/test synonyms, so the limit must
    // include position 4 to reach security-reviewer.
    const ranked = rankCatalog(crew, { objective: 'Fix auth python bug', stack: 'python' }, 4)
    assert.equal(ranked.length, 4)
    const rankedNames = ranked.map(agent => agent.name)
    assert.ok(rankedNames.includes('python-reviewer'), 'catalog rank must surface python-reviewer')
    assert.ok(rankedNames.includes('security-reviewer'), 'catalog rank must surface security-reviewer')

    // 9. Sync cached reader matches async (external coder path).
    const { getCachedSmallCrewSync } = await import('./ecc-crew')
    const syncCrew = getCachedSmallCrewSync()
    assert.ok(syncCrew.length >= 4, 'sync crew must load, got ' + syncCrew.length)
    assert.ok(syncCrew.some(agent => agent.name === 'code-reviewer'))
    assert.equal(getCachedSmallCrewSync(), syncCrew, 'sync reader caches per process')
  } else {
    // Checkout-absent fallback: pure-function paths still proven.
    const picked = selectCrewForTask([fake('code-reviewer'), fake('python-reviewer')], {
      objective: 'Fix python bug',
      stack: 'python',
    })
    assert.deepEqual(picked.map(agent => agent.name), ['code-reviewer', 'python-reviewer'])
    assert.ok(buildCrewGuidance(picked).includes('### Specialist: code-reviewer'))
    assert.equal(buildCrewGuidance([]), '')
  }

  console.log('ECC CREW TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
