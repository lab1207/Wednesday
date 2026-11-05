import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DefaultRoleRunnerDispatcher,
  FactoryOrchestrator,
  resolveRunBudget,
} from './index'
import type { AgentRole } from '../agents/types'
import type { EngineeringTask } from '../contracts'
import { InMemoryFactoryEventBus } from '../events'
import { recordUsage } from '../model-router/usage'

// V1.7 hardening — preemptive abort + spend budgets.
// Run: npx tsx factory/orchestrator/abort-budget-test.ts

function okRunner(summary: string, onCall?: () => void) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    async run(role: AgentRole) {
      calls += 1
      onCall?.()
      const output: Record<string, unknown> = {
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
    },
  }
}

function task(workspace: string): EngineeringTask {
  return {
    id: 'abort-budget-test',
    workspace,
    objective: 'test',
    role: 'backend',
    stack: 'node',
    constraints: [],
    acceptanceCriteria: [],
    acceptance: { requiredFiles: [] },
  }
}

async function main(): Promise<void> {
  const savedTokens = process.env.FACTORY_BUDGET_TOKENS
  const savedUsd = process.env.FACTORY_BUDGET_USD
  const savedMode = process.env.FACTORY_EXECUTION_MODE
  const temp = await mkdtemp(join(tmpdir(), 'abort-budget-'))

  try {
    delete process.env.FACTORY_BUDGET_TOKENS
    delete process.env.FACTORY_BUDGET_USD

    // 1. Budget resolution: unset/invalid -> unenforced; zero is a real cap.
    assert.deepEqual(resolveRunBudget(), {
      maxTokens: Number.POSITIVE_INFINITY,
      maxCostUsd: Number.POSITIVE_INFINITY,
    })
    process.env.FACTORY_BUDGET_TOKENS = '1000'
    process.env.FACTORY_BUDGET_USD = '2.5'
    assert.deepEqual(resolveRunBudget(), { maxTokens: 1000, maxCostUsd: 2.5 })
    process.env.FACTORY_BUDGET_TOKENS = 'abc'
    process.env.FACTORY_BUDGET_USD = '-1'
    assert.deepEqual(resolveRunBudget(), {
      maxTokens: Number.POSITIVE_INFINITY,
      maxCostUsd: Number.POSITIVE_INFINITY,
    })
    process.env.FACTORY_BUDGET_TOKENS = '0'
    delete process.env.FACTORY_BUDGET_USD
    assert.equal(resolveRunBudget().maxTokens, 0, 'zero must be a valid explicit cap')
    delete process.env.FACTORY_BUDGET_TOKENS

    // 2. Pre-aborted run: no stage starts, no repairs, task.failed.
    {
      const runners = new Map([
        ['architect', okRunner('a')],
        ['planner', okRunner('p')],
        ['coder', okRunner('c')],
        ['tester', okRunner('t')],
        ['reviewer', okRunner('r')],
      ])
      const bus = new InMemoryFactoryEventBus()
      const orchestrator = new FactoryOrchestrator(
        undefined,
        new DefaultRoleRunnerDispatcher(runners as never),
        { eventSink: bus, maxRepairAttempts: 3 },
      )
      const controller = new AbortController()
      controller.abort()
      const result = await orchestrator.run(task(temp), { signal: controller.signal })
      assert.equal(result.status, 'failed')
      assert.ok(
        result.blockingIssues.some((issue) => /bort/i.test(issue)),
        'failure must report abortion: ' + JSON.stringify(result.blockingIssues),
      )
      assert.equal(result.repairAttempts.length, 0, 'aborted run must not record repairs')
      for (const [id, runner] of runners) {
        assert.equal(runner.calls, 0, `aborted run must not start role ${id}`)
      }
      const types = (await bus.list(task(temp).id)).map((event) => event.type)
      assert.ok(types.includes('task.failed'), 'aborted run must emit task.failed')
      assert.ok(!types.includes('task.completed'), 'aborted run must not complete')
    }

    // 3. Token budget: spend recorded mid-run stops repair work before retry.
    {
      const coder = okRunner('c')
      const runners = new Map([
        ['architect', okRunner('a', () => recordUsage('budget-test-provider', 'budget-test-model', 500, 500))],
        ['planner', okRunner('p')],
        ['coder', coder],
        ['tester', okRunner('t')],
        ['reviewer', okRunner('r')],
      ])
      const bus = new InMemoryFactoryEventBus()
      const orchestrator = new FactoryOrchestrator(
        undefined,
        new DefaultRoleRunnerDispatcher(runners as never),
        { eventSink: bus, maxRepairAttempts: 3 },
      )
      process.env.FACTORY_BUDGET_TOKENS = '100'
      const result = await orchestrator.run(task(temp))
      assert.equal(result.status, 'failed')
      assert.ok(
        result.blockingIssues.some((issue) => /Budget exceeded/.test(issue)),
        'failure must report the budget: ' + JSON.stringify(result.blockingIssues),
      )
      assert.equal(coder.calls, 0, 'over-budget run must not start new coder work')
      assert.equal(result.repairAttempts.length, 0, 'over-budget run must not record repairs')
      delete process.env.FACTORY_BUDGET_TOKENS
    }

    // 4. Executor honors a pre-aborted signal without spawning any host.
    {
      process.env.FACTORY_EXECUTION_MODE = 'deterministic'
      const { FactoryExecutor } = await import('../executor/factory-executor')
      const executor = new FactoryExecutor()
      const controller = new AbortController()
      controller.abort()
      const result = await executor.execute(task(temp), { signal: controller.signal })
      assert.equal(result.status, 'failed')
      assert.match(String(result.diagnostics ?? ''), /bort/i)
    }

    // 5. Aborting an unknown Hermes run id is a safe no-op.
    {
      const { abortRunningTask } = await import('../hermes/store')
      assert.equal(abortRunningTask('no-such-task'), false)
    }

    console.log('ORCHESTRATOR ABORT/BUDGET TEST: PASS')
  } finally {
    if (savedTokens === undefined) delete process.env.FACTORY_BUDGET_TOKENS
    else process.env.FACTORY_BUDGET_TOKENS = savedTokens
    if (savedUsd === undefined) delete process.env.FACTORY_BUDGET_USD
    else process.env.FACTORY_BUDGET_USD = savedUsd
    if (savedMode === undefined) delete process.env.FACTORY_EXECUTION_MODE
    else process.env.FACTORY_EXECUTION_MODE = savedMode
    await rm(temp, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
