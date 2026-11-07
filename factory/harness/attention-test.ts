/**
 * The attention bell (2026-11-07).
 *
 * WHY THIS TEST EXISTS: the operator's second ask was to work out why
 * OpenCode feels engaging and add that quality to Wednesday. The answer, from
 * OpenCode's own V2 docs, is that five events make a sound and raise a system
 * notification: `permission`, `question`, `error`, `done` and
 * `subagent_done`. Wednesday had none of them -- the app went quiet after a
 * run, so a finished run and a running one looked the same.
 *
 * The rules that keep the bell from being noise are the whole point, so they
 * are asserted here: a quiet turn does not ring, a piped run never rings, an
 * error rings twice, and a permission ALWAYS rings.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point state home at a temp dir before importing the module.
const stateHome = mkdtempSync(join(tmpdir(), 'wed-attention-state-'))
process.env.WEDNESDAY_STATE_HOME = stateHome

const {
  ATTENTION_KINDS,
  BELL,
  DONE_RING_MIN_MS,
  attentionDecision,
  attentionLabel,
  bellBytes,
  bellEnabled,
} = await import('./attention')

async function main(): Promise<void> {
  // 1. The five OpenCode events are the five Wednesday events.
  assert.deepEqual(
    [...ATTENTION_KINDS],
    ['permission', 'question', 'error', 'done', 'subagent_done'],
    'the event set is OpenCode\'s, by name',
  )
  for (const kind of ATTENTION_KINDS) {
    assert.ok(attentionLabel(kind).length > 0, `every kind has a label: ${kind}`)
  }

  // 2. A permission ALWAYS rings: the run is waiting for a decision, and an
  //    operator who looked away has to be able to come back to it.
  const permission = attentionDecision('permission', 0)
  assert.equal(permission.ring, true)
  assert.equal(permission.bells, 1)

  // 3. A question always rings, for the same reason.
  assert.equal(attentionDecision('question', 0).ring, true)

  // 4. An error rings TWICE: one bell is easy to lose behind another window.
  const error = attentionDecision('error', 0)
  assert.equal(error.ring, true)
  assert.equal(error.bells, 2)

  // 5. A lane that finished on its own rings -- that IS the event.
  assert.equal(attentionDecision('subagent_done', 0).ring, true)

  // 6. A QUICK turn does not ring. A 200 ms answer was seen; a bell for it
  //    is noise, and a harness that beeps at every keystroke gets muted.
  assert.equal(attentionDecision('done', 0).ring, false, 'an instant turn is not an event')
  assert.equal(attentionDecision('done', DONE_RING_MIN_MS - 1).ring, false)
  assert.equal(attentionDecision('done', DONE_RING_MIN_MS).ring, true, 'a long turn rings')
  assert.equal(attentionDecision('done', 30_000).ring, true)

  // 7. A PIPED run never rings: a BEL byte inside captured output is garbage.
  assert.equal(attentionDecision('permission', 0, { interactive: false }).ring, false)
  assert.equal(attentionDecision('error', 0, { interactive: false }).ring, false)

  // 8. A muted bell never rings -- and it says why.
  const muted = attentionDecision('permission', 0, { muted: true })
  assert.equal(muted.ring, false)
  assert.match(muted.reason, /muted/)

  // 9. The bytes: one BEL per bell, and NOTHING when the decision is no.
  assert.equal(bellBytes(permission), BELL)
  assert.equal(bellBytes(error), BELL + BELL)
  assert.equal(bellBytes({ ring: false, bells: 0, reason: 'no' }), '')

  // 10. The escape hatch: WEDNESDAY_BELL=0 turns it off.
  assert.equal(bellEnabled({ WEDNESDAY_BELL: '0' }, true), false)
  assert.equal(bellEnabled({ WEDNESDAY_BELL: 'off' }, true), false)
  assert.equal(bellEnabled({}, true), true, 'on by default')
  assert.equal(bellEnabled({}, false), false, 'a pipe is never interactive')

  rmSync(stateHome, { recursive: true, force: true })
  console.log('ATTENTION TEST: PASS (five events, quiet turns stay quiet, pipes stay silent, errors ring twice)')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
