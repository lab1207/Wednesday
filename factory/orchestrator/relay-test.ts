/**
 * Offline test for the relay core. Pure asserts: rank + leader election,
 * remainder split, 1..N assignment, piece prompts, completion, env knobs,
 * and a full two-round race+relay simulation — no runners, no network.
 */
import assert from 'node:assert/strict'

import {
  assignPieces,
  bubbleUp,
  collectAnswers,
  electLeader,
  expandNode,
  findMergeConflicts,
  findNode,
  guessCapability,
  makeRelayRoot,
  openLeaves,
  openPieces,
  pieceToNode,
  rankRace,
  relayComplete,
  relayPiecePrompt,
  relayTreeComplete,
  reopenNode,
  resolveNode,
  resolveRelayDepth,
  resolveRelayEnabled,
  resolveRelayMaxRounds,
  resolveRelayProbeEnabled,
  resolveRelayRetries,
  resolveRelayWidth,
  splitRemainder,
  stuckLeaves,
  summarizeTree,
} from './relay'

async function main(): Promise<void> {
  // 1. Rank: fewest issues first, ties keep lane order.
  const ranked = rankRace([
    { model: 'm1', issues: 3 },
    { model: 'm2', issues: 3 },
    { model: 'm3', issues: 1 },
    { model: 'm4', issues: 7 },
  ])
  assert.deepEqual(
    ranked.map(lane => lane.model),
    ['m3', 'm1', 'm2', 'm4'],
  )

  // 2. Leader: best lane leads; total wipeout / empty elects nobody.
  assert.equal(electLeader(ranked)!.model, 'm3')
  assert.equal(
    electLeader([
      { model: 'm1', issues: Number.MAX_SAFE_INTEGER },
      { model: 'm2', issues: Number.MAX_SAFE_INTEGER },
    ]),
    null,
  )
  assert.equal(electLeader([]), null)

  // 3. Capability guess: vision/reasoning/review/complete keywords, else coding.
  assert.equal(guessCapability('the screenshot layout is broken'), 'vision')
  assert.equal(guessCapability('pick a different strategy'), 'reasoning')
  assert.equal(guessCapability('verify the audit verdict'), 'review')
  assert.equal(guessCapability('finish the missing handler'), 'complete')
  assert.equal(guessCapability('TypeError: undefined is not a function'), 'coding')

  // 4. Split: one failure = one piece, empties dropped, capped.
  const failures = [
    'Contract gate: missing required file server/notes.js.',
    '   ',
    'FAIL: node --test landing › renders hero',
    'screenshot hero overflows on mobile',
    'extra one beyond cap',
  ]
  const drafts = splitRemainder(failures, 3)
  assert.equal(drafts.length, 3)
  assert.deepEqual(
    drafts.map(draft => draft.id),
    ['piece-0', 'piece-1', 'piece-2'],
  )
  assert.equal(drafts[2]!.capability, 'vision')
  assert.deepEqual(splitRemainder([], 4), [])
  assert.equal(splitRemainder(['a', 'b', 'c'], 99).length, 3)

  // 5. Assign: empty pool assigns nobody (caller falls back).
  assert.deepEqual(
    assignPieces(drafts, [], {}).map(piece => piece.assignee),
    ['', '', ''],
  )

  // 6. Assign: solo pool takes everything (1-model shape).
  const solo = assignPieces(
    drafts,
    [{ id: 'only' }],
    { only: { reasoning: 90, coding: 90, vision: 90, review: 90, complete: 90 } },
  )
  assert.deepEqual(
    solo.map(piece => piece.assignee),
    ['only', 'only', 'only'],
  )

  // 7. Assign: best scorer per capability wins across N models.
  const pool = [{ id: 'brain' }, { id: 'hands' }, { id: 'eyes' }]
  const scores = {
    brain: { reasoning: 100, coding: 10, vision: 0, review: 20, complete: 10 },
    hands: { reasoning: 10, coding: 100, vision: 0, review: 20, complete: 60 },
    eyes: { reasoning: 0, coding: 0, vision: 100, review: 0, complete: 0 },
  }
  const team = assignPieces(drafts, pool, scores)
  assert.equal(team[0]!.assignee, 'hands') // coding/complete piece
  assert.equal(team[1]!.assignee, 'hands') // coding piece
  assert.equal(team[2]!.assignee, 'eyes') // vision piece

  // 8. Assign: no signal anywhere round-robins, so all N still work.
  const blind = assignPieces(drafts, pool, {})
  assert.deepEqual(
    blind.map(piece => piece.assignee),
    ['brain', 'hands', 'eyes'],
  )

  // 9. Assign: ties spread by load (4 pieces, 2 equal models → 2+2).
  const even = assignPieces(
    splitRemainder(['a bug', 'b bug', 'c bug', 'd bug'], 4),
    [{ id: 'x' }, { id: 'y' }],
    {},
  )
  const xCount = even.filter(piece => piece.assignee === 'x').length
  assert.equal(xCount, 2)

  // 10. Prompt: piece-scoped, names the leader.
  const prompt = relayPiecePrompt(drafts[0]!, 'hands', '7/10, 1 file missing')
  assert.ok(prompt.includes('piece-0'))
  assert.ok(prompt.includes('hands'))
  assert.ok(prompt.includes('Solve ONLY this piece'))
  // 10b. Retry prompt: try 2+ orders a different approach.
  assert.ok(!prompt.includes('STRATEGY CHANGE'))
  const retryPrompt = relayPiecePrompt(drafts[0]!, 'hands', '7/10', 2)
  assert.ok(retryPrompt.includes('STRATEGY CHANGE (try 2)'))

  // 11. Completion: done only when every piece is clean.
  assert.equal(relayComplete([], []), true)
  assert.equal(
    relayComplete(drafts, [
      { pieceId: 'piece-0', blockingIssues: [] },
      { pieceId: 'piece-1', blockingIssues: ['still failing'] },
    ]),
    false,
  )
  assert.deepEqual(
    openPieces(drafts, [{ pieceId: 'piece-0', blockingIssues: [] }]),
    ['piece-1', 'piece-2'],
  )
  assert.equal(
    relayComplete(drafts, [
      { pieceId: 'piece-0', blockingIssues: [] },
      { pieceId: 'piece-1', blockingIssues: [] },
      { pieceId: 'piece-2', blockingIssues: [] },
    ]),
    true,
  )

  // 12. Env knobs: defaults + clamps + junk.
  assert.equal(resolveRelayWidth({}), 4)
  assert.equal(resolveRelayWidth({ FACTORY_RELAY_WIDTH: '2' }), 2)
  assert.equal(resolveRelayWidth({ FACTORY_RELAY_WIDTH: '99' }), 8)
  assert.equal(resolveRelayWidth({ FACTORY_RELAY_WIDTH: 'junk' }), 4)
  assert.equal(resolveRelayMaxRounds({}), 5)
  assert.equal(resolveRelayMaxRounds({ FACTORY_RELAY_ROUNDS: '0' }), 0)
  assert.equal(resolveRelayMaxRounds({ FACTORY_RELAY_ROUNDS: '99' }), 10)
  assert.equal(resolveRelayMaxRounds({ FACTORY_RELAY_ROUNDS: 'junk' }), 5)

  // 13. Full loop simulation: race → leader → relay → 1 piece fails →
  // race-inside-race on the open piece → done.
  const race = rankRace([
    { model: 'm1', issues: 3 },
    { model: 'm2', issues: 3 },
    { model: 'm3', issues: 3 },
    { model: 'm4', issues: 1 },
  ])
  const leader = electLeader(race)!
  assert.equal(leader.model, 'm4') // the 9 leads the 7s
  const round1 = assignPieces(
    splitRemainder(
      ['missing file a.js', 'FAIL: renders hero', 'hero screenshot clip'],
      4,
    ),
    [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }],
    {
      m1: { reasoning: 0, coding: 70, vision: 0, review: 0, complete: 0 },
      m2: { reasoning: 0, coding: 60, vision: 0, review: 0, complete: 0 },
      m3: { reasoning: 0, coding: 0, vision: 0, review: 0, complete: 0 },
      m4: { reasoning: 80, coding: 80, vision: 80, review: 80, complete: 80 },
    },
  )
  // Strongest model leads every piece here; weaker coders pick up
  // coding pieces on tasks where the leader has no signal (see 7-9).
  assert.equal(round1[2]!.assignee, 'm4')
  assert.equal(round1[0]!.assignee, 'm4')
  const round1Results = [
    { pieceId: 'piece-0', blockingIssues: [] as string[] },
    { pieceId: 'piece-1', blockingIssues: ['still red'] },
    { pieceId: 'piece-2', blockingIssues: [] as string[] },
  ]
  assert.equal(relayComplete(round1, round1Results), false)
  // Race inside race: the open piece re-splits and re-assigns to all 4.
  const round2 = assignPieces(
    splitRemainder(['FAIL: renders hero (retry)'], 4),
    [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }],
    {
      m1: { reasoning: 0, coding: 70, vision: 0, review: 0, complete: 0 },
      m2: { reasoning: 0, coding: 60, vision: 0, review: 0, complete: 0 },
      m3: { reasoning: 0, coding: 0, vision: 0, review: 0, complete: 0 },
      m4: { reasoning: 80, coding: 80, vision: 80, review: 80, complete: 80 },
    },
  )
  assert.equal(round2.length, 1)
  assert.equal(round2[0]!.assignee, 'm4')
  assert.equal(
    relayComplete(round2, [{ pieceId: 'piece-0', blockingIssues: [] }]),
    true,
  )

  // 14. Tree: root + expand keeps dotted ids, depth+1, parent waits.
  const root = makeRelayRoot('build the landing page')
  assert.equal(root.depth, 0)
  assert.equal(root.status, 'open')
  root.children = assignPieces(
    splitRemainder(['missing hero.js', 'hero screenshot clip'], 4),
    [{ id: 'm1' }, { id: 'm4' }],
    {
      m1: { reasoning: 0, coding: 70, vision: 0, review: 0, complete: 0 },
      m4: { reasoning: 80, coding: 80, vision: 80, review: 80, complete: 80 },
    },
  ).map(piece => pieceToNode(piece, 1))
  assert.deepEqual(
    root.children.map(child => child.id),
    ['piece-0', 'piece-1'],
  )
  assert.deepEqual(openLeaves(root).map(leaf => leaf.id), [
    'piece-0',
    'piece-1',
  ])

  // 15. Inner loop: piece-1 fails → expands (race inside race) at depth 2.
  assert.equal(resolveNode(root, 'piece-0', true, 'hero.js written'), true)
  assert.equal(resolveNode(root, 'piece-1', false), true)
  assert.equal(relayTreeComplete(root), false)
  const inner = findNode(root, 'piece-1')!
  expandNode(
    inner,
    ['clip on mobile', 'clip on desktop'],
    [{ id: 'm1' }, { id: 'm4' }],
    {
      m1: { reasoning: 0, coding: 70, vision: 60, review: 0, complete: 0 },
      m4: { reasoning: 80, coding: 80, vision: 80, review: 80, complete: 80 },
    },
  )
  assert.deepEqual(
    inner.children.map(child => child.id),
    ['piece-1.0', 'piece-1.1'],
  )
  assert.equal(inner.children[0]!.depth, 2)
  // Expanded parent is not actionable; only real leaves are.
  assert.deepEqual(openLeaves(root).map(leaf => leaf.id), [
    'piece-1.0',
    'piece-1.1',
  ])
  // Resolving an expanded parent directly refuses.
  assert.equal(resolveNode(root, 'piece-1', true, 'nope'), false)

  // 16. Break + share: solved leaves bubble answers up to the root.
  assert.equal(resolveNode(root, 'piece-1.0', true, 'mobile clip fixed'), true)
  assert.equal(resolveNode(root, 'piece-1.1', true, 'desktop clip fixed'), true)
  assert.equal(bubbleUp(inner), true)
  assert.deepEqual(collectAnswers(inner), [
    'mobile clip fixed',
    'desktop clip fixed',
  ])
  assert.equal(relayTreeComplete(root), true)
  assert.deepEqual(collectAnswers(root), [
    'hero.js written',
    'mobile clip fixed',
    'desktop clip fixed',
  ])

  // 17. Stuck: failed leaf at max depth surfaces, below max it loops on.
  const stuckRoot = makeRelayRoot('stuck demo')
  stuckRoot.children = assignPieces(
    splitRemainder(['deep bug'], 4),
    [{ id: 'm1' }],
    {},
  ).map(piece => pieceToNode(piece, 2))
  assert.equal(resolveNode(stuckRoot, 'piece-0', false), true)
  assert.deepEqual(
    stuckLeaves(stuckRoot, 2).map(leaf => leaf.id),
    ['piece-0'],
  )
  assert.deepEqual(stuckLeaves(stuckRoot, 3), [])
  assert.equal(findNode(stuckRoot, 'nope'), null)

  // 18. Depth knob: default 2, clamped 0-5, junk falls back.
  assert.equal(resolveRelayDepth({}), 2)
  assert.equal(resolveRelayDepth({ FACTORY_RELAY_DEPTH: '0' }), 0)
  assert.equal(resolveRelayDepth({ FACTORY_RELAY_DEPTH: '9' }), 5)
  assert.equal(resolveRelayDepth({ FACTORY_RELAY_DEPTH: 'junk' }), 2)

  // 19. Gate: explicit opt-in, default off.
  assert.equal(resolveRelayEnabled({}), false)
  assert.equal(resolveRelayEnabled({ FACTORY_RELAY: '1' }), true)
  assert.equal(resolveRelayEnabled({ FACTORY_RELAY: 'on' }), true)
  assert.equal(resolveRelayEnabled({ FACTORY_RELAY: 'junk' }), false)

  // 19b. Probe gate: on unless explicitly disabled for zero-spend runs.
  assert.equal(resolveRelayProbeEnabled({}), true)
  assert.equal(resolveRelayProbeEnabled({ FACTORY_RELAY_PROBE: '0' }), false)
  assert.equal(resolveRelayProbeEnabled({ FACTORY_RELAY_PROBE: 'off' }), false)
  assert.equal(resolveRelayProbeEnabled({ FACTORY_RELAY_PROBE: '1' }), true)

  // 20b. Conflicts: shared files named, solo files silent, sorted.
  assert.deepEqual(
    findMergeConflicts([
      { id: 'piece-0', files: ['a.txt', 'shared.txt'] },
      { id: 'piece-1', files: ['b.txt', 'shared.txt', 'shared.txt'] },
      { id: 'piece-2', files: ['c.txt'] },
    ]),
    [{ file: 'shared.txt', pieces: ['piece-0', 'piece-1'] }],
  )
  assert.deepEqual(
    findMergeConflicts([{ id: 'solo', files: ['only.txt'] }]),
    [],
  )

  // 20c. Census: leaves counted by status for snapshots.
  const censusRoot = makeRelayRoot('census')
  censusRoot.children = assignPieces(
    splitRemainder(['a bug', 'b bug'], 4),
    [{ id: 'm1' }],
    {},
  ).map(piece => pieceToNode(piece, 1))
  assert.equal(resolveNode(censusRoot, 'piece-0', true, 'A'), true)
  assert.equal(resolveNode(censusRoot, 'piece-1', false), true)
  assert.deepEqual(summarizeTree(censusRoot), {
    open: [],
    done: ['piece-0'],
    failed: ['piece-1'],
  })

  // 20. Retries: per-piece tries before splitting inward + reopen rule.
  assert.equal(resolveRelayRetries({}), 3)
  assert.equal(resolveRelayRetries({ FACTORY_RELAY_RETRIES: '1' }), 1)
  assert.equal(resolveRelayRetries({ FACTORY_RELAY_RETRIES: '99' }), 10)
  assert.equal(resolveRelayRetries({ FACTORY_RELAY_RETRIES: 'junk' }), 3)
  const retryRoot = makeRelayRoot('retry demo')
  retryRoot.children = assignPieces(
    splitRemainder(['stubborn bug'], 4),
    [{ id: 'm1' }],
    {},
  ).map(piece => pieceToNode(piece, 1))
  assert.equal(resolveNode(retryRoot, 'piece-0', false), true)
  assert.deepEqual(openLeaves(retryRoot), [])
  assert.equal(reopenNode(retryRoot, 'piece-0'), true)
  assert.deepEqual(
    openLeaves(retryRoot).map(leaf => leaf.id),
    ['piece-0'],
  )
  // Reopen refuses done nodes and ghosts.
  assert.equal(resolveNode(retryRoot, 'piece-0', true, 'fixed'), true)
  assert.equal(reopenNode(retryRoot, 'piece-0'), false)
  assert.equal(reopenNode(retryRoot, 'ghost'), false)
  // Reopen refuses expanded parents (children own the work now).
  const wideRoot = makeRelayRoot('wide demo')
  wideRoot.children = assignPieces(
    splitRemainder(['x bug'], 4),
    [{ id: 'm1' }],
    {},
  ).map(piece => pieceToNode(piece, 1))
  assert.equal(resolveNode(wideRoot, 'piece-0', false), true)
  expandNode(findNode(wideRoot, 'piece-0')!, ['x1', 'x2'], [{ id: 'm1' }], {})
  assert.equal(reopenNode(wideRoot, 'piece-0'), false)

  console.log('RELAY CORE TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
