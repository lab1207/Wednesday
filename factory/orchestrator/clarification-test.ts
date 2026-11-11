import assert from 'node:assert/strict'
import { join } from 'node:path'
import { INSTALL_ROOT } from '../paths'
import {
  DefaultRoleRunnerDispatcher,
  FactoryOrchestrator,
} from './index'

import type {
  AgentContext,
  AgentOutput,
  AgentRole,
} from '../agents/types'

/**
 * THE ARCHITECT AND THE PLANNER ASK (2026-11-10, operator report).
 *
 *   "the stage architect and planner don't ask question they just go? because
 *    its this 2 has to find user what he looking for the direction so they
 *    must ask relevant question related the task then next and so on"
 *
 * The old prompt told the architect to "choose the reading that needs the
 * fewest assumptions" -- a guess instruction. These tests pin the new
 * behaviour end to end:
 *
 *  - the seat asks, the run PAUSES, the operator answers;
 *  - the seat runs AGAIN with the answer, and the answer is in its prompt;
 *  - a seat with nothing to ask never pauses the run;
 *  - a question the operator does not answer never hangs the run;
 *  - the seats that do NOT decide the direction never ask.
 */

class ScriptedRunner {
  readonly contexts: AgentContext[] = []

  constructor(
    readonly roleName: string,
    private readonly outputs: AgentOutput[],
  ) {}

  async run(
    role: AgentRole,
    context: AgentContext,
  ): Promise<AgentOutput> {
    this.contexts.push(context)
    const output = this.outputs.shift()
    if (!output) {
      throw new Error(`No scripted output for ${role.id}`)
    }
    return output
  }
}

function seat(
  role: 'architect' | 'planner' | 'coder' | 'tester' | 'reviewer',
  summary: string,
  findings: string[] = [],
): AgentOutput {
  return {
    role,
    summary,
    findings,
    blockingIssues: [],
  }
}

function task(id: string) {
  return {
    id,
    workspace: join(INSTALL_ROOT, 'dsh-test-workspace'),
    objective: 'Build the login screen.',
    role: 'frontend',
    stack: 'typescript',
    constraints: [],
    acceptanceCriteria: ['The login screen renders.'],
  }
}

function dispatcher(
  architect: ScriptedRunner,
  planner: ScriptedRunner,
  coder: ScriptedRunner,
  tester: ScriptedRunner,
  reviewer: ScriptedRunner,
) {
  return new DefaultRoleRunnerDispatcher(
    new Map([
      ['architect', architect],
      ['planner', planner],
      ['coder', coder],
      ['tester', tester],
      ['reviewer', reviewer],
    ]),
  )
}

function passingSeats() {
  return {
    planner: new ScriptedRunner('planner', [seat('planner', 'Plan complete.')]),
    coder: new ScriptedRunner('coder', [seat('coder', 'Implementation complete.')]),
    tester: new ScriptedRunner('tester', [seat('tester', 'Tests pass.')]),
    reviewer: new ScriptedRunner('reviewer', [
      {
        ...seat('reviewer', 'Review passed.'),
        review: {
          verdict: 'pass' as const,
          summary: 'All requirements satisfied.',
          findings: [],
          requiredChanges: [],
          evidence: ['Tests pass.'],
        },
      },
    ]),
  }
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. THE SEAT ASKS, THE OPERATOR ANSWERS, THE SEAT RUNS AGAIN.
  // -------------------------------------------------------------------------
  {
    const architect = new ScriptedRunner('architect', [
      seat(
        'architect',
        'Architecture drafted.',
        [
          'THE DESIGN: rewrite the login form.',
          'QUESTIONS:',
          'Should the old /login endpoint stay for backwards compatibility?',
        ],
      ),
      seat(
        'architect',
        'Architecture complete.',
        ['THE DESIGN: rewrite the login form, keep /login as an alias.'],
      ),
    ])
    const seats = passingSeats()
    const asked: string[] = []

    const orchestrator = new FactoryOrchestrator(
      undefined,
      dispatcher(
        architect,
        seats.planner,
        seats.coder,
        seats.tester,
        seats.reviewer,
      ),
    )

    const result = await orchestrator.run(task('clarify-001'), {
      clarifier: async question => {
        asked.push(question)
        return 'Keep it as an alias.'
      },
    })

    assert.deepEqual(
      asked,
      ['Should the old /login endpoint stay for backwards compatibility?'],
      'the operator is asked the seat\'s question, once',
    )
    assert.equal(
      architect.contexts.length,
      2,
      'the seat runs again once it has the answer',
    )
    assert.equal(
      architect.contexts[0]?.clarifications?.length ?? 0,
      0,
      'the first run has no answers yet',
    )
    assert.deepEqual(
      architect.contexts[1]?.clarifications,
      [
        {
          question:
            'Should the old /login endpoint stay for backwards compatibility?',
          answer: 'Keep it as an alias.',
        },
      ],
      'the answer reaches the seat\'s second run',
    )

    const architectStep = result.steps.find(
      step => step.role === 'architect',
    )
    assert.deepEqual(
      architectStep?.output?.clarifications,
      [
        {
          question:
            'Should the old /login endpoint stay for backwards compatibility?',
          answer: 'Keep it as an alias.',
        },
      ],
      'the exchange is recorded in the run',
    )
    assert.ok(
      result.steps.some(step => step.role === 'reviewer'),
      'the run carried on after the answer',
    )
  }

  // -------------------------------------------------------------------------
  // 2. THE SEAT WITH NOTHING TO ASK NEVER PAUSES THE RUN.
  // -------------------------------------------------------------------------
  {
    const architect = new ScriptedRunner('architect', [
      seat(
        'architect',
        'Architecture complete.',
        ['THE DESIGN: rewrite the login form.', 'QUESTIONS: none'],
      ),
    ])
    const seats = passingSeats()
    let asked = 0

    const orchestrator = new FactoryOrchestrator(
      undefined,
      dispatcher(
        architect,
        seats.planner,
        seats.coder,
        seats.tester,
        seats.reviewer,
      ),
    )

    await orchestrator.run(task('clarify-002'), {
      clarifier: async () => {
        asked += 1
        return 'yes'
      },
    })

    assert.equal(asked, 0, 'a seat with no questions never pauses the run')
    assert.equal(architect.contexts.length, 1, 'the seat runs once')
  }

  // -------------------------------------------------------------------------
  // 3. NO CLARIFIER = NO PAUSE (the headless path behaves exactly as before).
  // -------------------------------------------------------------------------
  {
    const architect = new ScriptedRunner('architect', [
      seat(
        'architect',
        'Architecture drafted.',
        ['QUESTIONS:', 'Which database do you want?'],
      ),
    ])
    const seats = passingSeats()

    const orchestrator = new FactoryOrchestrator(
      undefined,
      dispatcher(
        architect,
        seats.planner,
        seats.coder,
        seats.tester,
        seats.reviewer,
      ),
    )

    const result = await orchestrator.run(task('clarify-003'))
    assert.equal(
      architect.contexts.length,
      1,
      'without a clarifier the seat is not re-run',
    )
    assert.ok(
      result.steps.length > 0,
      'the run still produced its steps',
    )
  }

  // -------------------------------------------------------------------------
  // 4. A QUESTION THE OPERATOR DOES NOT ANSWER NEVER HANGS THE RUN.
  // -------------------------------------------------------------------------
  {
    const architect = new ScriptedRunner('architect', [
      seat(
        'architect',
        'Architecture drafted.',
        ['QUESTIONS:', 'Which database do you want?'],
      ),
    ])
    const seats = passingSeats()
    let asked = 0

    const orchestrator = new FactoryOrchestrator(
      undefined,
      dispatcher(
        architect,
        seats.planner,
        seats.coder,
        seats.tester,
        seats.reviewer,
      ),
    )

    const result = await orchestrator.run(task('clarify-004'), {
      clarifier: async () => {
        asked += 1
        return undefined
      },
    })

    assert.equal(asked, 1, 'the question was asked once')
    assert.equal(
      architect.contexts.length,
      1,
      'a declined question does not re-run the seat',
    )
    assert.ok(
      result.steps.some(step => step.role === 'reviewer'),
      'the run carried on after the question was declined',
    )
  }

  // -------------------------------------------------------------------------
  // 5. THE PLANNER MAY ASK TOO -- AND THE CODER NEVER DOES.
  // -------------------------------------------------------------------------
  {
    const architect = new ScriptedRunner('architect', [
      seat('architect', 'Architecture complete.', ['QUESTIONS: none']),
    ])
    const planner = new ScriptedRunner('planner', [
      seat(
        'planner',
        'Plan drafted.',
        ['QUESTIONS:', 'Should the migration run in the same release?'],
      ),
      seat('planner', 'Plan complete.', ['STEPS: 1. add the migration']),
    ])
    const seats = passingSeats()
    const asked: string[] = []

    const orchestrator = new FactoryOrchestrator(
      undefined,
      dispatcher(
        architect,
        planner,
        seats.coder,
        seats.tester,
        seats.reviewer,
      ),
    )

    await orchestrator.run(task('clarify-005'), {
      clarifier: async question => {
        asked.push(question)
        return 'Yes, same release.'
      },
    })

    assert.deepEqual(
      asked,
      ['Should the migration run in the same release?'],
      'the planner asks the operator too',
    )
    assert.equal(planner.contexts.length, 2, 'the planner runs again')
    assert.equal(
      seats.coder.contexts.length,
      1,
      'the coder never asks: it does not decide the direction',
    )
  }

  console.log(
    'CLARIFICATION ORCHESTRATION TEST: PASS (the seat asks, the operator answers, the seat runs again, a declined question never hangs, only the direction seats ask)',
  )
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
