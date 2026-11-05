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

import type { AgentRunner } from './types'

class ScriptedRunner implements AgentRunner {
  constructor(
    private readonly roleName: string,
    private readonly outputs: AgentOutput[],
    private readonly calls: string[],
  ) {}

  async run(
    role: AgentRole,
    _context: AgentContext,
  ): Promise<AgentOutput> {
    this.calls.push(`${this.roleName}:${role.id}`)

    const output = this.outputs.shift()

    if (!output) {
      throw new Error(`No scripted output for ${role.id}`)
    }

    return output
  }
}

async function main(): Promise<void> {
  const calls: string[] = []

  const architectRunner = new ScriptedRunner(
    'architect',
    [{
      role: 'architect',
      summary: 'Architecture complete.',
      findings: [],
      blockingIssues: [],
    }],
    calls,
  )

  const plannerRunner = new ScriptedRunner(
    'planner',
    [{
      role: 'planner',
      summary: 'Plan complete.',
      findings: [],
      blockingIssues: [],
    }],
    calls,
  )

  const coderRunner = new ScriptedRunner(
    'coder',
    [
      {
        role: 'coder',
        summary: 'Initial implementation complete.',
        findings: [],
        blockingIssues: [],
      },
      {
        role: 'coder',
        summary: 'Repair complete.',
        findings: ['Reviewer fixes applied.'],
        blockingIssues: [],
      },
    ],
    calls,
  )

  const testerRunner = new ScriptedRunner(
    'tester',
    [
      {
        role: 'tester',
        summary: 'Initial tests pass.',
        findings: [],
        blockingIssues: [],
      },
      {
        role: 'tester',
        summary: 'Tests pass after repair.',
        findings: [],
        blockingIssues: [],
      },
    ],
    calls,
  )

  const reviewerRunner = new ScriptedRunner(
    'reviewer',
    [
      {
        role: 'reviewer',
        summary: 'Implementation needs repair.',
        findings: ['Division-by-zero behavior is incorrect.'],
        blockingIssues: ['Division-by-zero behavior is incorrect.'],
        review: {
          verdict: 'fail',
          summary: 'Repair required.',
          findings: ['Division-by-zero behavior is incorrect.'],
          requiredChanges: [
            'Raise ZeroDivisionError when divisor is zero.',
          ],
          evidence: [],
        },
      },
      {
        role: 'reviewer',
        summary: 'Implementation is ready.',
        findings: [],
        blockingIssues: [],
        review: {
          verdict: 'pass',
          summary: 'All requirements satisfied.',
          findings: [],
          requiredChanges: [],
          evidence: [
            'Tests pass.',
          ],
        },
      },
    ],
    calls,
  )

  const dispatcher = new DefaultRoleRunnerDispatcher(
    new Map([
      ['architect', architectRunner],
      ['planner', plannerRunner],
      ['coder', coderRunner],
      ['tester', testerRunner],
      ['reviewer', reviewerRunner],
    ]),
  )

  const orchestrator = new FactoryOrchestrator(
    undefined,
    dispatcher,
    {
      maxRepairAttempts: 3,
    },
  )

  const result = await orchestrator.run({
    id: 'repair-test-001',
    workspace: join(INSTALL_ROOT, 'dsh-test-workspace'),
    objective: 'Test the repair loop.',
    role: 'backend',
    stack: 'python',
    constraints: [],
    acceptanceCriteria: [
      'Reviewer failure triggers another coder run.',
    ],
  })

  console.log(JSON.stringify({
    calls,
    result,
  }, null, 2))
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})