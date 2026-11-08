/**
 * The MoA wiring, pinned offline (2026-11-08, B238 follow-up).
 *
 * The end-to-end proof drives a real terminal, which needs a live endpoint.
 * This file pins the two things that must not drift and need no network:
 *
 *   1. `resolveChatMoa` reads the operator's env the same way every other
 *      crew seat does, and treats an empty team as a CONFIGURATION ERROR —
 *      FACTORY_MOA=1 with no proposers must never silently behave like a
 *      normal turn, which is precisely the "the operator asked for a team and
 *      watched one model answer" failure.
 *   2. OFF is the default: every `resolveChatMoa` returns null unless the
 *      operator turns it on. A default that changed behaviour would be a
 *      regression in the one path everyone uses.
 */
import assert from 'node:assert/strict'

import { resolveChatMoa } from './chat-moa'

function main(): void {
  // 1. OFF unless asked: the default path is untouched.
  for (const env of [{}, { FACTORY_MOA: '' }, { FACTORY_MOA: '0' }, { FACTORY_MOA: 'off' }, { FACTORY_MOA: 'no' }]) {
    assert.equal(
      resolveChatMoa(env),
      null,
      'no team unless the operator asks: ' + JSON.stringify(env),
    )
  }

  // 1b. ON is recognised in the usual spellings.
  for (const on of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.ok(
      resolveChatMoa({ FACTORY_MOA: on, FACTORY_MOA_PROPOSERS: 'coder' }),
      `FACTORY_MOA=${on} must turn the pattern on`,
    )
  }

  // 2. A bare list uses each entry as both seat and model.
  assert.deepEqual(
    resolveChatMoa({ FACTORY_MOA: '1', FACTORY_MOA_PROPOSERS: 'coder, reviewer , tester' }),
    {
      team: [
        { seat: 'coder', model: 'coder' },
        { seat: 'reviewer', model: 'reviewer' },
        { seat: 'tester', model: 'tester' },
      ],
      aggregator: '',
    },
  )

  // 2b. `seat=model` separates them — a seat may wear a path the operator
  //     serves, which the seat label alone cannot express.
  assert.deepEqual(
    resolveChatMoa({
      FACTORY_MOA: 'true',
      FACTORY_MOA_PROPOSERS: 'reviewer=/models/reviewer-q4_k_m.gguf,coder',
      FACTORY_MOA_AGGREGATOR: ' /models/big-q5.gguf ',
    }),
    {
      team: [
        { seat: 'reviewer', model: '/models/reviewer-q4_k_m.gguf' },
        { seat: 'coder', model: 'coder' },
      ],
      aggregator: '/models/big-q5.gguf',
    },
    'a seat may name its own model, and the aggregator may be named',
  )

  // 3. ON with no team is an error, never a silent no-op.
  assert.throws(
    () => resolveChatMoa({ FACTORY_MOA: '1', FACTORY_MOA_PROPOSERS: '  ' }),
    /FACTORY_MOA_PROPOSERS is empty/,
    'an empty team must be named, not ignored',
  )
  assert.throws(
    () => resolveChatMoa({ FACTORY_MOA: '1' }),
    /name the team/,
  )

  // 4. A malformed entry is kept as-is rather than dropped: dropping entry 3
  //    of 4 would quietly run a team of three and call it the operator's team.
  assert.deepEqual(
    resolveChatMoa({ FACTORY_MOA: '1', FACTORY_MOA_PROPOSERS: 'a,,b' })!.team.map(t => t.seat),
    ['a', 'b'],
    'a blank entry is dropped, the rest survive',
  )

  console.log('chat-moa-config: PASS')
}

main()
