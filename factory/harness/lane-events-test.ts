/**
 * Lane events in the crew dock: the TEAM lane made visible.
 *
 * A team run puts several seats in ONE role (two coder lanes in a duel,
 * three reviewer ballots in a vote). Before lane events the dock had a row
 * per ROLE, so the last lane to report erased every other one — the operator
 * saw a single seat, not a crew. These asserts are pure folds over the
 * events: no run, no network, no filesystem.
 */
import assert from 'node:assert/strict'

import { crewStripRows, crewUpdate, initialState, type CrewRow } from './screen'
import type { FactoryEvent } from '../events/types'

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g
const strip = (s: string): string => s.replace(ANSI, '')

async function main(): Promise<void> {
  // 1. lane.started: a row with the lane label and the model that runs it.
  const rows: CrewRow[] = []
  crewUpdate(rows, 'lane.started', 'coder', undefined, undefined, {
    lane: 'duel-0',
    model: 'qwen3-coder:free',
    role: 'coder',
    round: 0,
  })
  assert.equal(rows.length, 1, 'a lane start creates one row')
  assert.equal(rows[0]!.lane, 'duel-0', 'the row carries the lane label')
  assert.equal(rows[0]!.role, 'coder', 'the row carries the lane role')
  assert.equal(rows[0]!.phase, 'working', 'a started lane is working')
  assert.equal(
    rows[0]!.detail,
    'qwen3-coder:free',
    'the row names the model that runs the lane',
  )

  // 2. A lane row and a plain seat row of the same role are TWO rows.
  const mixed: CrewRow[] = []
  crewUpdate(mixed, 'agent.started', 'coder')
  crewUpdate(mixed, 'lane.started', 'coder', undefined, undefined, {
    lane: 'duel-1',
    model: 'gemma-3-4b-it',
    role: 'coder',
    round: 0,
  })
  assert.equal(mixed.length, 2, 'a lane never merges into the plain seat row')
  assert.equal(
    mixed.find(row => row.lane === undefined)?.role,
    'coder',
    'the plain seat row survives',
  )
  assert.equal(
    mixed.find(row => row.lane === 'duel-1')?.detail,
    'gemma-3-4b-it',
    'the lane row keeps its own model',
  )
  const state = initialState('Wednesday', 'live')
  state.crew = mixed
  const dock = strip(crewStripRows(state, 100, 40, Date.now()).join('\n'))
  assert.match(dock, /coder duel-1/, 'the dock names the lane, not just the role')
  assert.match(dock, /coder\s+working/, 'the plain seat row is still there')

  // 3. lane.completed with ok:false is a DEAD lane, not a finished one.
  crewUpdate(rows, 'lane.completed', 'coder', undefined, undefined, {
    lane: 'duel-0',
    model: 'qwen3-coder:free',
    role: 'coder',
    ok: false,
  })
  assert.equal(rows[0]!.phase, 'failed', 'a lane that failed is red in the dock, not green')
  assert.equal(rows.length, 1, 'a lane completion never creates a second row')

  // 4. lane.scored puts the grade on the row.
  const scored: CrewRow[] = []
  crewUpdate(scored, 'lane.started', 'coder', undefined, undefined, {
    lane: 'duel-0',
    model: 'qwen3-coder:free',
    role: 'coder',
    round: 0,
  })
  crewUpdate(scored, 'lane.scored', 'coder', undefined, undefined, {
    lane: 'duel-0',
    model: 'qwen3-coder:free',
    score: 2,
    detail: 'blocking issues',
  })
  assert.match(scored[0]!.detail ?? '', /2/, 'the score reaches the row')
  assert.equal(scored[0]!.phase, 'working', 'a score never invents a verdict')

  // A ballot has no number of its own: the verdict is the truth it has.
  const ballot: CrewRow[] = []
  crewUpdate(ballot, 'lane.started', 'reviewer', undefined, undefined, {
    lane: 'vote-0',
    model: 'gemma-3-4b-it',
    role: 'reviewer',
    round: 0,
  })
  crewUpdate(ballot, 'lane.scored', 'reviewer', undefined, undefined, {
    lane: 'vote-0',
    model: 'gemma-3-4b-it',
    score: null,
    detail: 'verdict pass',
  })
  assert.equal(ballot[0]!.detail, 'verdict pass', 'a ballot without a number shows its verdict')

  // 5. The event vocabulary: `lane.started` is a real FactoryEvent type.
  const event: FactoryEvent = {
    id: 'evt-lane-1',
    type: 'lane.started',
    taskId: 'task-1',
    timestamp: '2026-11-06T00:00:00.000Z',
    role: 'coder',
    payload: { lane: 'relay-0', model: 'qwen3-coder:free', role: 'coder', round: 2 },
  }
  const fromEvent: CrewRow[] = []
  crewUpdate(fromEvent, event.type, event.role, undefined, undefined, event.payload)
  assert.equal(fromEvent.length, 1, 'the event payload folds into the dock')
  assert.equal(fromEvent[0]!.lane, 'relay-0', 'the event payload carries the lane')

  console.log('LANE EVENTS: lane rows coexist with seat rows, failures and scores land')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
