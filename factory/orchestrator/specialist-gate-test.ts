/**
 * Offline test for the ECC specialist gate (phase 2). No network, no model:
 * a ReviewRunner with an injected responder proves pass-through, fail
 * collection with teeth (specialist name + findings), malformed-output
 * tolerance, empty-crew silence, and difficulty-band caps.
 */
import assert from 'node:assert/strict'

import type { EngineeringTask } from '../contracts'
import type { AgentOutput } from '../agents/types'
import type { RegistryModelRouter } from '../model-router'
import { ReviewRunner, selectForGate } from '../agents/role-runners'
import type { EccAgent } from '../agents/ecc-crew'

const fakeCatalog = (): EccAgent[] => [
  ...fakeCrew,
  { name: 'rust-governor', description: 'Rust ownership and borrow checker expert.', body: '- check borrows' },
  { name: 'go-scout', description: 'Go concurrency routines expert.', body: '- check goroutines' },
  { name: 'doc-scribe', description: 'Documentation writer.', body: '- check docs' },
]

const fakeCrew: EccAgent[] = [
  { name: 'code-reviewer', description: 'Generalist.', body: '- check one' },
  { name: 'python-reviewer', description: 'Pythonist.', body: '- check py' },
  { name: 'security-reviewer', description: 'Paranoid.', body: '- check auth' },
]

function baseTask(): EngineeringTask {
  return {
    id: 'specialist-gate-test',
    workspace: '/tmp/specialist-gate',
    objective: 'Fix the python login bug with auth tokens',
    role: 'backend',
    stack: 'python',
    constraints: [],
    acceptanceCriteria: ['Login works.'],
    acceptance: { requiredFiles: [] },
  }
}

const passJson = JSON.stringify({
  verdict: 'pass',
  summary: 'fine',
  findings: [],
  requiredChanges: [],
  evidence: [],
})

const failJson = JSON.stringify({
  verdict: 'fail',
  summary: 'leak',
  findings: ['auth token logged'],
  requiredChanges: ['stop logging tokens'],
  evidence: ['grep'],
})

async function main(): Promise<void> {
  const runner = new ReviewRunner({} as unknown as RegistryModelRouter)
  const outputs: AgentOutput[] = [
    { role: 'coder', summary: 'wrote fix', findings: [], recommendations: [], blockingIssues: [] },
  ]

  // 1. All specialists pass → gate empty.
  const pass = await runner.runSpecialistGate(outputs, baseTask(), {
    crew: fakeCrew,
    responder: async () => passJson,
  })
  assert.deepEqual(pass, [])

  // 2. One specialist fails → collected with name + findings (teeth).
  const fail = await runner.runSpecialistGate(outputs, baseTask(), {
    crew: fakeCrew,
    responder: async specialist => (specialist.name === 'security-reviewer' ? failJson : passJson),
  })
  assert.equal(fail.length, 1)
  assert.equal(fail[0].specialist, 'security-reviewer')
  assert.deepEqual(fail[0].findings, ['auth token logged'])
  assert.deepEqual(fail[0].requiredChanges, ['stop logging tokens'])

  // 2b. Parallel reviewers flagging the SAME finding merge (dedup).
  const duped = await runner.runSpecialistGate(outputs, baseTask(), {
    crew: fakeCrew,
    responder: async () => failJson,
  })
  const allFindings = duped.flatMap(entry => entry.findings)
  assert.equal(allFindings.length, 1, 'identical findings must merge to one repair entry')
  assert.equal(duped[0].specialist, 'code-reviewer', 'first reporter attributed')

  // 3. Malformed specialist output never blocks.
  const garbage = await runner.runSpecialistGate(outputs, baseTask(), {
    crew: fakeCrew,
    responder: async () => 'Engineering Report prose, no JSON',
  })
  assert.deepEqual(garbage, [])

  // 4. Empty crew → silent empty gate.
  const empty = await runner.runSpecialistGate(outputs, baseTask(), {
    crew: [],
    responder: async () => failJson,
  })
  assert.deepEqual(empty, [])

  // 5. Difficulty cap bounds how many specialists run.
  let calls = 0
  await runner.runSpecialistGate(outputs, baseTask(), {
    crew: fakeCrew,
    responder: async () => {
      calls += 1
      return passJson
    },
    maxAgents: 2,
  })
  assert.equal(calls, 2, 'band cap must bound specialist runs')

  // 6. Pure selection: band cap over the small crew; sweep ranks the catalog.
  const picked = selectForGate(fakeCrew, fakeCatalog(), { objective: 'Fix python bug', stack: 'python' }, 2)
  assert.equal(picked.length, 2)
  assert.equal(picked[0].name, 'code-reviewer')
  const swept = selectForGate(fakeCrew, fakeCatalog(), { objective: 'Fix rust bug', stack: 'rust' }, 10, true)
  assert.ok(swept.length > fakeCrew.length, 'sweep must reach beyond the small crew')
  assert.equal(swept[0].name, 'code-reviewer', 'spine still leads the sweep')
  const sweptNames = swept.map(agent => agent.name)
  assert.ok(sweptNames.indexOf('rust-governor') < sweptNames.indexOf('doc-scribe'), 'relevant specialist must outrank irrelevant ones')

  console.log('SPECIALIST GATE TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
