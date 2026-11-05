/**
 * Offline test for the ECC engineering-rules loader. No network, no model:
 * common always loads, stack dirs match task text, bodies capped, guidance
 * renders, missing checkout stays silent.
 */
import assert from 'node:assert/strict'

import {
  buildRulesGuidance,
  defaultEccRulesHome,
  loadRulesForTask,
} from './ecc-rules'

async function main(): Promise<void> {
  // 1. Real checkout (only when present).
  const home = defaultEccRulesHome()
  const python = await loadRulesForTask({ stack: 'python', objective: 'Fix bug' }, home)
  if (python.length > 0) {
    const stacks = new Set(python.map(rule => rule.stack))
    assert.ok(stacks.has('common'), 'common rules always load')
    assert.ok(stacks.has('python'), 'stack dir loads on match')
    for (const rule of python) {
      assert.ok(rule.body.length <= 1500, 'bodies capped')
      assert.ok(['coding-style', 'patterns', 'security', 'testing'].includes(rule.kind))
    }
    const rust = await loadRulesForTask({ stack: 'rust', objective: 'Fix borrow error' }, home)
    assert.ok(rust.some(rule => rule.stack === 'rust'), 'rust dir matches rust tasks')
    const unknown = await loadRulesForTask({ stack: 'cobol', objective: 'Hello' }, home)
    assert.ok(unknown.length > 0, 'common loads even without a stack match')
    assert.ok(unknown.every(rule => rule.stack === 'common'))

    const guidance = buildRulesGuidance(python)
    assert.ok(guidance.includes('## ENGINEERING RULES'))
    assert.ok(guidance.includes('### python/security'))
    console.log(`  real checkout: python ${python.length} rules, rust ${rust.length} rules`)
  } else {
    // Checkout-absent fallback stays silent.
    const empty = await loadRulesForTask({ stack: 'python' }, '/nonexistent-dir-xyz')
    assert.deepEqual(empty, [])
  }

  // 2. Guidance silent when empty (pure, no checkout needed).
  assert.equal(buildRulesGuidance([]), '')

  // 3. Sync cached reader matches async (external coder path).
  const { getCachedRulesForTaskSync } = await import('./ecc-rules')
  const syncPython = getCachedRulesForTaskSync({ stack: 'python', objective: 'Fix bug' })
  const asyncPython = await loadRulesForTask({ stack: 'python', objective: 'Fix bug' }, home)
  if (asyncPython.length > 0) {
    assert.equal(syncPython.length, asyncPython.length, 'sync/async readers must agree')
  } else {
    assert.deepEqual(getCachedRulesForTaskSync({ stack: 'python', home: '/nonexistent-dir-xyz' }), [])
  }

  console.log('ECC RULES TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
