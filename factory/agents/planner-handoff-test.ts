import assert from 'node:assert/strict'

import { buildPlannerGuidance } from './role-runners'
import type { AgentContext } from './types'

function contextWith(
  previousOutputs: AgentContext['previousOutputs'],
): AgentContext {
  return {
    task: {
      id: 'planner-handoff-test-001',
      workspace: 'test-workspace',
      objective: 'Verify planner guidance.',
      constraints: [],
      acceptanceCriteria: [],
    },
    workspace: 'test-workspace',
    previousOutputs,
  }
}

async function main(): Promise<void> {
  // No planner output → no guidance section.
  assert.equal(
    buildPlannerGuidance(contextWith([])),
    '',
  )

  // Planner recommendations + findings surface explicitly.
  const guidance = buildPlannerGuidance(
    contextWith([
      {
        role: 'architect',
        summary: 'architecture prepared.',
      },
      {
        role: 'planner',
        summary: 'plan prepared.',
        findings: ['Create server/notes.js first.'],
        recommendations: [
          'Create server/notes.js exporting createNote.',
          'Wire public/app.js login.',
        ],
      },
    ]),
  )
  assert.ok(
    guidance.startsWith('PLANNER GUIDANCE:'),
    guidance,
  )
  assert.ok(
    guidance.includes('server/notes.js'),
    guidance,
  )

  // Latest planner wins when several exist.
  const latest = buildPlannerGuidance(
    contextWith([
      {
        role: 'planner',
        summary: 'old plan.',
        recommendations: ['Old step.'],
      },
      {
        role: 'planner',
        summary: 'new plan.',
        recommendations: ['New step.'],
      },
    ]),
  )
  assert.ok(latest.includes('New step.'))
  assert.ok(!latest.includes('Old step.'))

  // Empty planner output stays silent.
  assert.equal(
    buildPlannerGuidance(
      contextWith([
        {
          role: 'planner',
          summary: 'plan with no detail.',
        },
      ]),
    ),
    '',
  )

  console.log(
    'PLANNER HANDOFF TEST: PASS (absent, surfaced, latest-wins, empty-silent)',
  )
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
