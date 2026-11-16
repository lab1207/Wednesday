/**
 * Offline proof of the per-run model pool (2026-11-16).
 *
 * No network, no credentials: these are the decisions that must be identical
 * on every machine — which model takes which role, what is refused before a
 * job is queued, and how an explicit seat overlay merges.
 */
import assert from 'node:assert/strict'

import {
  assignPool,
  checkModels,
  mergeSeats,
  modelAccess,
  parseSeatOverrides,
} from './model-pool'

import { crewEnvSnapshot, restoreCrewEnv } from './crew-store'

/* --- reachability: local is always allowed, hosted needs its key --------- */

assert.deepEqual(modelAccess('local/qwen2.5-coder-3b', {}), { ok: true })

assert.deepEqual(modelAccess('nvidia/nvidia/nemotron', { NVIDIA_API_KEY: 'x' }), {
  ok: true,
})

const noKey = modelAccess('openrouter/deepseek/deepseek-chat', {})
assert.equal(noKey.ok, false)
assert.ok(noKey.reason?.includes('OPENROUTER_API_KEY'), noKey.reason)

const unpinned = modelAccess('qwen2.5-coder-3b', {})
assert.equal(unpinned.ok, false)
assert.ok(unpinned.reason?.includes('provider-pinned'), unpinned.reason)

assert.deepEqual(
  modelAccess('qwen2.5-coder-3b', { FACTORY_LLM_PROVIDER: 'local' }),
  { ok: true },
)

/* --- a whole pool is checked in one pass -------------------------------- */

const errors = checkModels(
  ['local/qwen', 'openrouter/x', 'openrouter/x', ''],
  {},
)
assert.equal(errors.length, 1)
assert.ok(errors[0].includes('OPENROUTER_API_KEY'), errors[0])

/* --- role-aware assignment, deterministic ------------------------------- */

const pool = [
  'nvidia/qwen2.5-coder-3b',
  'local/qwen2.5-vl-3b',
  'nvidia/nvidia/nemotron-3-ultra-550b',
]

const seats = assignPool(pool)
const byRole = Object.fromEntries(seats.map(seat => [seat.role, seat.model]))

assert.equal(byRole.architect, 'nvidia/nvidia/nemotron-3-ultra-550b')
assert.equal(byRole.planner, 'nvidia/nvidia/nemotron-3-ultra-550b')
assert.equal(byRole.coder, 'nvidia/qwen2.5-coder-3b')
assert.equal(byRole.tester, 'nvidia/qwen2.5-coder-3b')
assert.equal(byRole.vision, 'local/qwen2.5-vl-3b')
assert.equal(byRole['security-audit'], 'nvidia/nvidia/nemotron-3-ultra-550b')

assert.deepEqual(assignPool(pool), seats, 'assignment must be deterministic')
assert.equal(new Set(seats.map(seat => seat.model)).size, 3)
assert.equal(seats.length, 9, 'every seat gets a model')

const single = assignPool(['local/one-model'])
assert.equal(new Set(single.map(seat => seat.model)).size, 1)
assert.equal(single.length, 9)

/* --- explicit seats and overlays ---------------------------------------- */

const parsed = parseSeatOverrides({
  coder: 'local/coder',
  architect: 'local/arch',
})

assert.deepEqual(parsed.errors, [])
assert.equal(parsed.seats.length, 2)

const bad = parseSeatOverrides({ wizard: 'local/x' })
assert.equal(bad.seats.length, 0)
assert.ok(bad.errors[0].includes('Unknown seat role'), bad.errors[0])
assert.ok(bad.errors[0].includes('architect'), bad.errors[0])

const merged = mergeSeats(
  [
    { role: 'architect', model: 'pool/arch' },
    { role: 'coder', model: 'pool/coder' },
  ],
  [{ role: 'coder', model: 'host/coder' }],
)
assert.deepEqual(merged, [
  { role: 'architect', model: 'pool/arch' },
  { role: 'coder', model: 'host/coder' },
])

/* --- a transient crew restores the env exactly --------------------------- */

const env: NodeJS.ProcessEnv = {
  FACTORY_CREW_CODER_MODEL: 'before',
  FACTORY_EXPANSION: 'solo',
}

const snapshot = crewEnvSnapshot(env)
env.FACTORY_CREW_CODER_MODEL = 'during'
env.FACTORY_CREW_REVIEWER_MODEL = 'new'
env.FACTORY_EXPANSION = 'duel'
restoreCrewEnv(snapshot, env)

assert.equal(env.FACTORY_CREW_CODER_MODEL, 'before')
assert.equal(env.FACTORY_CREW_REVIEWER_MODEL, undefined)
assert.equal(env.FACTORY_EXPANSION, 'solo')

console.log('MODEL POOL TEST: PASS (access, assignment, overrides, env restore)')
