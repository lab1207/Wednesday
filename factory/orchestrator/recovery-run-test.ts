/**
 * Integration test for failure recovery (2026-09-23). Stub runners + a
 * fake diagnoser prove: ceiling triggers diagnosis, the fresh plan lands
 * as planner guidance the coder actually sees, the granted budget lets
 * the run converge; a throwing diagnoser (or zero rounds) fails exactly
 * as history did. No models, no network.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DefaultRoleRunnerDispatcher, FactoryOrchestrator } from './index'
import type { AgentRunner } from './types'
import type { AgentContext, AgentOutput, AgentRole, AgentRoleId } from '../agents/types'
import type { EngineeringTask } from '../contracts'
import { InMemoryFactoryEventBus } from '../events'

function cleanOutput(roleId: AgentRoleId, summary: string): AgentOutput {
  return {
    role: roleId,
    summary,
    findings: [],
    recommendations: [],
    blockingIssues: [],
  }
}

function makeTask(workspace: string, id: string): EngineeringTask {
  return {
    id,
    workspace,
    objective: 'Build a small widget.',
    role: 'backend',
    stack: 'python',
    constraints: [],
    acceptanceCriteria: [],
  }
}

const DIAGNOSIS = [
  'The coder repeats the same write without checking the file landed.',
  '1. Write the missing file before any other file.',
  '2. Read the file back after writing.',
  '3. Run the tests before declaring done.',
].join('\n')

async function main(): Promise<void> {
  const savedExpansion = process.env.FACTORY_EXPANSION
  process.env.FACTORY_EXPANSION = 'solo'

  try {
    // 1. Recovery converges: 2 failures hit the ceiling, diagnosis writes
    // a fresh plan, the coder sees it as planner guidance and passes.
    {
      let coderCalls = 0
      const sawRecoveryPlan: boolean[] = []
      const coder = async (role: AgentRole, context: AgentContext): Promise<AgentOutput> => {
        coderCalls += 1
        sawRecoveryPlan.push(
          context.previousOutputs.some(
            output =>
              output.role === 'planner' &&
              output.summary.includes('Recovery plan adopted'),
          ),
        )
        if (coderCalls <= 2) {
          return {
            ...cleanOutput(role.id, `coder failed ${coderCalls}`),
            blockingIssues: ['coder wrote nothing usable'],
          }
        }
        return cleanOutput(role.id, 'coder recovered')
      }
      const pass = async (role: AgentRole): Promise<AgentOutput> => {
        const output = cleanOutput(role.id, `${role.id} ok`)
        if (role.id === 'reviewer') {
          output.review = { verdict: 'pass', summary: 'ok', findings: [], requiredChanges: [], evidence: [] }
        }
        return output
      }
      const wrap = (fn: AgentRunner['run']): AgentRunner => ({ run: fn })
      const dispatcher = new DefaultRoleRunnerDispatcher(
        new Map([
          ['architect', wrap(pass)],
          ['planner', wrap(pass)],
          ['coder', wrap(coder)],
          ['tester', wrap(pass)],
          ['reviewer', wrap(pass)],
        ]),
      )
      const root = mkdtempSync(join(tmpdir(), 'wed-recover-'))
      const workspace = join(root, 'task')
      mkdirSync(workspace, { recursive: true })

      try {
        let diagnosed = 0
        const orchestrator = new FactoryOrchestrator(undefined, dispatcher, {
          eventSink: new InMemoryFactoryEventBus(),
          maxRepairAttempts: 1,
          recoveryRounds: 1,
          diagnoser: async (prompt: string) => {
            diagnosed += 1
            assert.ok(prompt.includes('Build a small widget.'))
            return DIAGNOSIS
          },
        })
        const result = await orchestrator.run(makeTask(workspace, 'recovery-test-001'))
        assert.equal(result.status, 'completed')
        assert.equal(diagnosed, 1, 'diagnosis must run exactly once')
        assert.equal(coderCalls, 3, `two failures then a recovered pass, got ${coderCalls} calls`)
        assert.deepEqual(sawRecoveryPlan, [false, false, true])
        assert.ok(
          result.repairAttempts.some(attempt =>
            attempt.reason.some(reason => reason.includes('Recovery plan adopted')),
          ),
          'the recovery round must stay visible in history',
        )
        console.log('RECOVERY: ceiling diagnosed, fresh plan landed, run converged')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    // 2. Throwing diagnoser fails exactly as history did.
    {
      const coder = async (role: AgentRole): Promise<AgentOutput> => ({
        ...cleanOutput(role.id, 'coder failed'),
        blockingIssues: ['coder wrote nothing usable'],
      })
      const pass = async (role: AgentRole): Promise<AgentOutput> => {
        const output = cleanOutput(role.id, `${role.id} ok`)
        if (role.id === 'reviewer') {
          output.review = { verdict: 'pass', summary: 'ok', findings: [], requiredChanges: [], evidence: [] }
        }
        return output
      }
      const wrap = (fn: AgentRunner['run']): AgentRunner => ({ run: fn })
      const dispatcher = new DefaultRoleRunnerDispatcher(
        new Map([
          ['architect', wrap(pass)],
          ['planner', wrap(pass)],
          ['coder', wrap(coder)],
          ['tester', wrap(pass)],
          ['reviewer', wrap(pass)],
        ]),
      )
      const root = mkdtempSync(join(tmpdir(), 'wed-recoverfail-'))
      const workspace = join(root, 'task')
      mkdirSync(workspace, { recursive: true })

      try {
        const orchestrator = new FactoryOrchestrator(undefined, dispatcher, {
          eventSink: new InMemoryFactoryEventBus(),
          maxRepairAttempts: 1,
          recoveryRounds: 1,
          diagnoser: async (): Promise<string> => {
            throw new Error('reasoner down')
          },
        })
        const result = await orchestrator.run(makeTask(workspace, 'recovery-test-002'))
        assert.equal(result.status, 'failed')
        assert.ok(
          result.blockingIssues.some(issue => issue.includes('after coder failure')),
          `original ceiling message must survive, got ${JSON.stringify(result.blockingIssues)}`,
        )
        assert.ok(
          result.repairAttempts.every(attempt =>
            attempt.reason.every(reason => !reason.includes('Recovery plan adopted')),
          ),
          'no recovery entries on diagnosis failure',
        )
        console.log('RECOVERY FAIL-OPEN: throwing diagnoser keeps historical failure')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  } finally {
    if (savedExpansion === undefined) delete process.env.FACTORY_EXPANSION
    else process.env.FACTORY_EXPANSION = savedExpansion
  }

  console.log('RECOVERY EXECUTION TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
