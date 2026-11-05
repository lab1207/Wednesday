/**
 * Offline test for failure recovery policy. Pure asserts: round budget,
 * stall detection, prompt shape/hygiene, lenient plan parse — no
 * runners, no models, no filesystem.
 */
import assert from 'node:assert/strict'

import {
  buildDiagnosisPrompt,
  failureSignature,
  isStalled,
  parseRecoveryPlan,
  resolveRecoveryRounds,
} from './recovery'
import type { RepairAttempt } from './types'

function attempt(reason: string, findings: string[] = []): RepairAttempt {
  return { attempt: 1, reason: [reason], reviewerFindings: findings, requiredChanges: [] }
}

async function main(): Promise<void> {
  // 1. Budget: off by default, explicit wins, env next, clamp 0–3.
  assert.equal(resolveRecoveryRounds(), 0)
  assert.equal(resolveRecoveryRounds(undefined, {}), 0)
  assert.equal(resolveRecoveryRounds(2), 2)
  assert.equal(resolveRecoveryRounds(9), 3)
  assert.equal(resolveRecoveryRounds(undefined, { FACTORY_RECOVERY_ROUNDS: '1' }), 1)
  assert.equal(resolveRecoveryRounds(undefined, { FACTORY_RECOVERY_ROUNDS: 'junk' }), 0)
  assert.equal(resolveRecoveryRounds(2, { FACTORY_RECOVERY_ROUNDS: '1' }), 2)

  // 2. Stall: identical last two fail the same way; singles never stall.
  assert.equal(isStalled([]), false)
  assert.equal(isStalled([attempt('coder failed')]), false)
  assert.equal(
    isStalled([attempt('coder failed: missing x'), attempt('coder failed: missing x')]),
    true,
  )
  assert.equal(
    isStalled([attempt('coder failed: missing x'), attempt('tester failed: red')]),
    false,
  )
  assert.equal(
    failureSignature(attempt('  CODER   failed ')),
    failureSignature(attempt('coder failed')),
  )

  // 3. Prompt: task + history carried, shape demanded, stall noted, capped.
  const prompt = buildDiagnosisPrompt(
    { objective: 'Build widget.', stack: 'python' },
    [attempt('Coder stage failed.', ['missing lane.txt']), attempt('Coder stage failed.', ['missing lane.txt'])],
  )
  assert.ok(prompt.includes('Build widget.'))
  assert.ok(prompt.includes('ROOT CAUSE'))
  assert.ok(prompt.includes('NEW STRATEGY'))
  assert.ok(prompt.includes('identically'), 'stall must be flagged')
  assert.ok(prompt.length <= 6000, `prompt mechanically bounded, got ${prompt.length}`)
  const nostall = buildDiagnosisPrompt({ objective: 'x' }, [attempt('a'), attempt('b')])
  assert.ok(!nostall.includes('identically'))

  // 4. Parse: steps become strategies, first line the cause, blanks fail open.
  const plan = parseRecoveryPlan(
    'The notes file is never written because the coder stops early.\n1. Write server/notes.js first, then auth.\n2. Run node --test before declaring done.\n- Stop trusting stopReason=completed.',
  )
  assert.ok(plan.rootCause.includes('never written'))
  assert.deepEqual(plan.strategies, [
    'Write server/notes.js first, then auth.',
    'Run node --test before declaring done.',
    'Stop trusting stopReason=completed.',
  ])
  assert.deepEqual(parseRecoveryPlan('   \n  ').strategies, [])

  console.log('RECOVERY POLICY TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
