// R1 relentless loops - the repair ceiling is user-set, and attempts
// past the old hard stop of 3 converge instead of dying.
//
// Run: npx tsx factory/orchestrator/relentless-test.ts
//
// Proves (offline, scripted runners):
// 1. A coder that fails 4 times then passes completes with cap 6 -
//    repairAttempts.length (4) is the visible prompts-to-green count.
// 2. The cap still bites: an always-failing coder with cap 2 fails.
// 3. resolveMaxRepairAttempts: explicit wins, env overrides the
//    default 3, invalid env falls back to 3, zero is a valid cap.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DefaultRoleRunnerDispatcher,
  FactoryOrchestrator,
  resolveMaxRepairAttempts,
  ceilingResumeHint,
} from './index'
import { repairEscalationGuidance } from '../agents/role-runners'
import type { AgentRunner } from './types'
import type {
  AgentContext,
  AgentOutput,
  AgentRole,
} from '../agents/types'
import type { EngineeringTask } from '../contracts'
import { InMemoryFactoryEventBus } from '../events'

class ScriptedRunner
  implements AgentRunner
{
  private calls = 0

  constructor(
    private readonly script: (
      call: number,
    ) => AgentOutput,
  ) {}

  async run(
    role: AgentRole,
    _context: AgentContext,
  ): Promise<AgentOutput> {
    this.calls += 1
    return this.script(this.calls)
  }
}

function okOutput(
  role: AgentRole,
  summary: string,
): AgentOutput {
  const output: AgentOutput = {
    role: role.id,
    summary,
    findings: [],
    recommendations: [],
    blockingIssues: [],
  }

  if (role.id === 'reviewer') {
    output.review = {
      verdict: 'pass',
      summary: 'ok',
      findings: [],
      requiredChanges: [],
      evidence: [],
    }
  }

  return output
}

function failOutput(
  call: number,
): AgentOutput {
  return {
    role: 'coder',
    summary: `attempt ${call} failed`,
    findings: [],
    recommendations: [],
    blockingIssues: [
      `DSH host verification failed on attempt ${call}`,
    ],
  }
}

async function main(): Promise<void> {
  const temp = await mkdtemp(
    join(tmpdir(), 'relentless-'),
  )

  // This file locks SOLO engine semantics (ceilings, ladders, hints) —
  // expansion shapes (duel/vote) have their own test. Pin solo so a
  // policy change can never silently rewrite these counts.
  const savedExpansion = process.env.FACTORY_EXPANSION
  process.env.FACTORY_EXPANSION = 'solo'

  try {
    const task: EngineeringTask = {
      id: 'relentless-test',
      workspace: temp,
      objective: 'test',
      role: 'backend',
      stack: 'node',
      constraints: [],
      acceptanceCriteria: [],
      acceptance: { requiredFiles: [] },
    }

    const dispatcherFor = (
      coder: AgentRunner,
    ): DefaultRoleRunnerDispatcher =>
      new DefaultRoleRunnerDispatcher(
        new Map([
          [
            'architect',
            {
              run: async (
                role: AgentRole,
              ) => okOutput(role, 'a'),
            },
          ],
          [
            'planner',
            {
              run: async (
                role: AgentRole,
              ) => okOutput(role, 'p'),
            },
          ],
          ['coder', coder],
          [
            'tester',
            {
              run: async (
                role: AgentRole,
              ) => okOutput(role, 't'),
            },
          ],
          [
            'reviewer',
            {
              run: async (
                role: AgentRole,
              ) => okOutput(role, 'r'),
            },
          ],
        ]),
      )

    // 1. Fails 4 times, passes on the 5th - past the old stop of 3.
    const stubborn = new ScriptedRunner(
      (call: number) =>
        call <= 4
          ? failOutput(call)
          : {
              role: 'coder',
              summary:
                'fifth attempt ok',
              findings: [],
              recommendations: [],
              blockingIssues: [],
            },
    )

    const relentless =
      new FactoryOrchestrator(
        undefined,
        dispatcherFor(stubborn),
        {
          eventSink:
            new InMemoryFactoryEventBus(),
          maxRepairAttempts: 6,
        },
      )

    const converged =
      await relentless.run(task)

    assert.equal(
      converged.status,
      'completed',
      JSON.stringify(
        converged.blockingIssues,
      ),
    )
    assert.equal(
      converged.repairAttempts.length,
      4,
      'four failures must produce four visible repair attempts',
    )

    // 2. The ceiling still bites.
    const hopeless = new ScriptedRunner(
      (call: number) =>
        failOutput(call),
    )

    const capped =
      new FactoryOrchestrator(
        undefined,
        dispatcherFor(hopeless),
        {
          eventSink:
            new InMemoryFactoryEventBus(),
          maxRepairAttempts: 2,
        },
      )

    const exhausted = await capped.run({
      ...task,
      id: 'relentless-capped',
    })

    assert.notEqual(
      exhausted.status,
      'completed',
    )
    // Engine semantic (unchanged by R1): the cap bounds continuations,
    // each failed try is recorded - so cap 2 records 3 attempts. The
    // ceiling bites and every attempt stays visible.
    assert.equal(
      exhausted.repairAttempts.length,
      3,
    )

    // R4: the ceiling names the position and the way back.
    assert.ok(
      exhausted.blockingIssues.some(
        issue =>
          issue.includes(
            'Ceiling hit after 3 recorded attempts',
          ) &&
          issue.includes(
            'relentless-capped',
          ) &&
          issue.includes(
            'FACTORY_MAX_REPAIR_ATTEMPTS',
          ),
      ),
      'exhaustion must carry the resume hint',
    )
    assert.match(
      ceilingResumeHint('t-1', 7),
      /Ceiling hit after 7 recorded attempts \(task t-1\)/,
    )

    // 3. Ceiling resolution.
    const saved =
      process.env
        .FACTORY_MAX_REPAIR_ATTEMPTS

    try {
      delete process.env
        .FACTORY_MAX_REPAIR_ATTEMPTS
      assert.equal(
        resolveMaxRepairAttempts(),
        3,
      )
      assert.equal(
        resolveMaxRepairAttempts(6),
        6,
      )
      assert.equal(
        resolveMaxRepairAttempts(0),
        0,
      )

      process.env.FACTORY_MAX_REPAIR_ATTEMPTS =
        '50'
      assert.equal(
        resolveMaxRepairAttempts(),
        50,
      )
      assert.equal(
        resolveMaxRepairAttempts(6),
        6,
        'explicit must win over env',
      )

      process.env.FACTORY_MAX_REPAIR_ATTEMPTS =
        '0'
      assert.equal(
        resolveMaxRepairAttempts(),
        0,
        'zero is a valid explicit cap',
      )

      process.env.FACTORY_MAX_REPAIR_ATTEMPTS =
        'many'
      assert.equal(
        resolveMaxRepairAttempts(),
        3,
        'invalid env must fall back to 3',
      )

      process.env.FACTORY_MAX_REPAIR_ATTEMPTS =
        '-2'
      assert.equal(
        resolveMaxRepairAttempts(),
        3,
        'negative env must fall back to 3',
      )

      process.env.FACTORY_MAX_REPAIR_ATTEMPTS =
        'unlimited'
      assert.equal(
        resolveMaxRepairAttempts(),
        Number.POSITIVE_INFINITY,
        'unlimited env removes the ceiling (never-stop mode)',
      )
      assert.equal(
        resolveMaxRepairAttempts('unlimited'),
        Number.POSITIVE_INFINITY,
        'unlimited explicit removes the ceiling',
      )
    } finally {
      if (saved === undefined) {
        delete process.env
          .FACTORY_MAX_REPAIR_ATTEMPTS
      } else {
        process.env.FACTORY_MAX_REPAIR_ATTEMPTS =
          saved
      }
    }

    // 4. R2 escalation tiers.
    assert.equal(
      repairEscalationGuidance(0),
      '',
    )
    assert.equal(
      repairEscalationGuidance(1),
      '',
      'round 1 keeps the standard wording',
    )
    assert.match(
      repairEscalationGuidance(2),
      /STRATEGY CHANGE/,
    )
    assert.match(
      repairEscalationGuidance(3),
      /STRATEGY CHANGE/,
    )
    assert.match(
      repairEscalationGuidance(4),
      /SPLIT AND LAND/,
    )
    assert.match(
      repairEscalationGuidance(9),
      /SPLIT AND LAND/,
    )

    console.log(
      'RELENTLESS TEST: PASS (converged after 4 failures, ceiling bites, resolves, ladder tiers)',
    )
  } finally {
    if (savedExpansion === undefined) {
      delete process.env.FACTORY_EXPANSION
    } else {
      process.env.FACTORY_EXPANSION = savedExpansion
    }
    await rm(temp, {
      recursive: true,
      force: true,
    })
  }
}

void main().catch(
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  },
)
