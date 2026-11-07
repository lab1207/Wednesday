import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Point state home at a temp dir before importing the module.
const tmp = join(tmpdir(), `crew-store-test-${Date.now()}`)
mkdirSync(tmp, { recursive: true })
process.env.WEDNESDAY_STATE_HOME = join(tmp, '.wednesday', 'state')

const {
  loadCrews, saveCrews, addCrew, updateCrew, deleteCrew,
  activeCrew, setActiveCrew, applyCrew, crewMeterName, crewSeatCount,
  crewRoutingSeatCount, crewSeatSummary,
} = await import('./crew-store')

test('load empty', () => {
  const s = loadCrews()
  assert.deepEqual(s.crews, [])
  assert.equal(s.active, null)
})

test('add crew', () => {
  const c = addCrew('solo-crew', [{ role: 'planner', model: 'm1' }, { role: 'coder', model: 'm1' }])
  assert.equal(c.name, 'solo-crew')
  assert.equal(c.seats.length, 2)
  assert.ok(c.id)
  const s = loadCrews()
  assert.equal(s.crews.length, 1)
  assert.equal(s.active, c.id)
})

test('add second crew does not change active', () => {
  const c2 = addCrew('trio', [{ role: 'planner', model: 'm1' }, { role: 'coder', model: 'm2' }, { role: 'vision', model: 'm3' }])
  assert.equal(loadCrews().active, loadCrews().crews[0].id)
  assert.equal(loadCrews().crews.length, 2)
})

test('set active crew', () => {
  const s = loadCrews()
  const id = s.crews[1].id
  setActiveCrew(id)
  assert.equal(loadCrews().active, id)
  assert.equal(activeCrew()?.name, 'trio')
})

test('crewMeterName single model', () => {
  const c = addCrew('single', [{ role: 'planner', model: 'm' }, { role: 'coder', model: 'm' }])
  assert.equal(crewMeterName(c), 'm')
})

test('crewMeterName mixed models', () => {
  const c = { id: 'x', name: 'mixed', seats: [{ role: 'planner', model: 'a' }, { role: 'coder', model: 'b' }] }
  assert.equal(crewMeterName(c), 'mixed · 2 seats')
})

// A team's extra seats are DISPLAY seats: only the first three map to a
// pipeline slot. A plate that said "6 seats" without saying so overstated
// what a run would use (operator, 2026-11-04).
test('crew seat summary says how many seats actually route', () => {
  const trio = { id: 'x', name: 'trio', seats: [
    { role: 'planner', model: 'a' }, { role: 'coder', model: 'b' }, { role: 'vision', model: 'c' },
  ] }
  assert.equal(crewRoutingSeatCount(trio), 3)
  assert.equal(crewSeatSummary(trio), '3 seats')
  const six = { id: 'y', name: 'six', seats: [
    ...trio.seats,
    { role: 'worker-4', model: 'd' }, { role: 'worker-5', model: 'e' }, { role: 'worker-6', model: 'f' },
  ] }
  assert.equal(crewRoutingSeatCount(six), 3)
  assert.equal(crewSeatSummary(six), '6 seats · 3 route')
  // A team smaller than the trio: every seat it has routes.
  const pair = { id: 'z', name: 'pair', seats: [{ role: 'planner', model: 'a' }, { role: 'coder', model: 'b' }] }
  assert.equal(crewRoutingSeatCount(pair), 2)
  assert.equal(crewSeatSummary(pair), '2 seats')
  assert.equal(crewSeatSummary(null), '0 seats')
})

test('update crew', () => {
  const s = loadCrews()
  const id = s.crews[0].id
  const updated = updateCrew(id, { name: 'renamed' })
  assert.equal(updated?.name, 'renamed')
  assert.equal(loadCrews().crews.find(c => c.id === id)?.name, 'renamed')
})

test('delete crew', () => {
  const s = loadCrews()
  const id = s.crews[0].id
  const ok = deleteCrew(id)
  assert.equal(ok, true)
  assert.equal(loadCrews().crews.find(c => c.id === id), undefined)
})

test('delete missing crew', () => {
  assert.equal(deleteCrew('nonexistent'), false)
})

test('applyCrew sets env', () => {
  const crew = addCrew('apply-test', [{ role: 'planner', model: 'm-plan' }, { role: 'coder', model: 'm-code' }, { role: 'vision', model: 'm-vis' }])
  applyCrew(crew)
  assert.equal(process.env.FACTORY_CREW_PLANNER_MODEL, 'm-plan')
  assert.equal(process.env.FACTORY_CREW_CODER_MODEL, 'm-code')
  assert.equal(process.env.FACTORY_CREW_VISION_MODEL, 'm-vis')

  // 2026-10-30 (teams are the product): a smaller crew CLEARS the slots it
  // does not fill. Switching solo over a trio used to leave the trio's
  // models answering silently — the team you selected is the team you get.
  const solo = addCrew('apply-solo', [{ role: 'planner', model: 'm-solo' }])
  applyCrew(solo)
  assert.equal(process.env.FACTORY_CREW_PLANNER_MODEL, 'm-solo')
  assert.equal(process.env.FACTORY_CREW_CODER_MODEL, '', 'unfilled coder slot clears on switch')
  assert.equal(process.env.FACTORY_CREW_VISION_MODEL, '', 'unfilled vision slot clears on switch')
})

test('a policy can be SET and CLEARED (2026-11-06)', () => {
  // `/team reset` writes `policy: undefined`. The old `updateCrew` checked
  // `patch.policy !== undefined`, which cannot tell "not mentioned" from
  // "explicitly cleared" - so the reset wrote the same policy straight back
  // and the team kept working the way the operator had just cleared.
  const crew = addCrew('policy-test', [{ role: 'planner', model: 'm-plan' }])
  const set = updateCrew(crew.id, { policy: { shape: 'duel', budgetTokens: 1000 } })
  assert.equal(set?.policy?.shape, 'duel')
  assert.equal(loadCrews().crews.find(c => c.id === crew.id)?.policy?.budgetTokens, 1000)

  const cleared = updateCrew(crew.id, { policy: undefined })
  assert.equal(cleared?.policy, undefined, 'the policy is gone')
  const reread = loadCrews().crews.find(c => c.id === crew.id)
  assert.equal(reread?.policy, undefined, 'and it stays gone on disk')

  // A patch that does not MENTION the policy leaves it alone.
  updateCrew(crew.id, { policy: { shape: 'vote' } })
  const renamed = updateCrew(crew.id, { name: 'policy-test-2' })
  assert.equal(renamed?.name, 'policy-test-2')
  assert.equal(renamed?.policy?.shape, 'vote', 'an unrelated patch does not clear the policy')
})

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true })
})

console.log('CREW STORE TEST: PASS')
