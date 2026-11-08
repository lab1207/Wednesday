/**
 * A failed seat still produced evidence (2026-11-07).
 *
 * The operator's run wrote a correct page and the Factory's own gate failed.
 * The failed coder's output was dropped, which meant:
 *
 *  - the repair attempt was handed the ORIGINAL prompt with ZERO feedback,
 *    so the coder answered "no changes were needed" until the ceiling ran
 *    out;
 *  - the receipt said "no changed files were reported" while the workspace
 *    held the file the coder had written.
 *
 * These assertions are the regression: the next attempt must SEE the failed
 * attempt's blocking issues, and the receipt must name what landed.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DefaultRoleRunnerDispatcher, FactoryOrchestrator } from './index'
import type { AgentRunner } from './types'
import type {
  AgentContext,
  AgentOutput,
  AgentRole,
  AgentRoleId,
} from '../agents/types'
import type { EngineeringTask } from '../contracts'
import { InMemoryFactoryEventBus } from '../events'

const REAL_REASON =
  "The Factory's own checks failed (1 check). Verification command failed: missing <h1>"

function cleanOutput(
  roleId: AgentRoleId,
  summary: string,
): AgentOutput {
  return {
    role: roleId,
    summary,
    findings: [],
    recommendations: [],
    blockingIssues: [],
  }
}

function makeTask(
  workspace: string,
  id: string,
): EngineeringTask {
  return {
    id,
    workspace,
    objective: 'Build me website',
    role: 'frontend',
    stack: 'html',
    constraints: [],
    acceptanceCriteria: ['index.html exists'],
  }
}

async function main(): Promise<void> {
  const root =
    mkdtempSync(
      join(
        tmpdir(),
        'wed-failed-evidence-',
      ),
    )

  const workspace =
    join(root, 'task')

  mkdirSync(
    workspace,
    { recursive: true },
  )

  try {
    let coderCalls = 0
    const feedbackSeen: string[] = []
    const previousCoderSeen: string[] = []

    const coder =
      async (
        role: AgentRole,
        context: AgentContext,
      ): Promise<AgentOutput> => {
        coderCalls += 1

        // What the NEXT attempt can see about the PREVIOUS one.
        const previousCoder =
          context.previousOutputs.filter(
            output => output.role === 'coder',
          )

        for (const output of previousCoder) {
          previousCoderSeen.push(
            output.blockingIssues.join(' | '),
          )
        }

        if (coderCalls === 1) {
          return {
            ...cleanOutput(
              role.id,
              'coder wrote the page',
            ),
            findings: [
              'Created index.html',
            ],
            blockingIssues: [REAL_REASON],
            filesChanged: ['index.html'],
          }
        }

        // The repair attempt reads the previous failure out of the prompt the
        // coder builds from `previousOutputs`.
        feedbackSeen.push(
          context.task.objective,
        )

        return {
          ...cleanOutput(
            role.id,
            'coder recovered',
          ),
          filesChanged: ['index.html'],
        }
      }

    const pass =
      async (
        role: AgentRole,
      ): Promise<AgentOutput> => {
        const output =
          cleanOutput(
            role.id,
            `${role.id} ok`,
          )

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

    const wrap =
      (
        fn: AgentRunner['run'],
      ): AgentRunner =>
        ({
          run: fn,
        })

    const dispatcher =
      new DefaultRoleRunnerDispatcher(
        new Map([
          ['architect', wrap(pass)],
          ['planner', wrap(pass)],
          ['coder', wrap(coder)],
          ['tester', wrap(pass)],
          ['reviewer', wrap(pass)],
        ]),
      )

    const orchestrator =
      new FactoryOrchestrator(
        undefined,
        dispatcher,
        {
          eventSink:
            new InMemoryFactoryEventBus(),
          maxRepairAttempts: 2,
          recoveryRounds: 0,
        },
      )

    const result =
      await orchestrator.run(
        makeTask(
          workspace,
          'failed-evidence-001',
        ),
      )

    assert.equal(
      coderCalls,
      2,
      `the run must repair once, got ${coderCalls} coder calls`,
    )

    // 1. THE AMNESIA FIX: the second attempt sees the first attempt's
    //    blocking issues. Before the fix this list was empty.
    assert.ok(
      previousCoderSeen.length > 0,
      'the repair attempt must see the previous coder attempt',
    )
    assert.ok(
      previousCoderSeen.some(
        seen => seen.includes('own checks failed'),
      ),
      `the repair attempt must see the REAL reason, got: ${JSON.stringify(previousCoderSeen)}`,
    )

    // 2. The receipt names the files that landed, even though the seat that
    //    wrote them failed. The list belongs to the RUN, not to the last seat
    //    (the reviewer writes no files).
    assert.ok(
      result.filesChanged.includes(
        'index.html',
      ),
      `the receipt must list the file the coder wrote, got: ${JSON.stringify(result.filesChanged)}`,
    )

    // 3. The real reason is recorded as the reason for the repair -- not a
    //    success transcript, and not "Coder stage failed." on its own.
    assert.ok(
      result.repairAttempts.length > 0,
      'the run must record the repair attempt',
    )
    const recorded =
      result.repairAttempts
        .flatMap(
          attempt => attempt.reviewerFindings,
        )
        .join('\n')

    assert.ok(
      recorded.includes('own checks failed'),
      `the repair record must carry the real reason, got: ${JSON.stringify(result.repairAttempts)}`,
    )

    console.log(
      'failed-seat-evidence: PASS',
    )
  } finally {
    rmSync(
      root,
      { recursive: true, force: true },
    )
  }
}

void main().catch(
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  },
)
