import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DefaultRoleRunnerDispatcher,
  FactoryOrchestrator,
  checkContractGate,
} from './index'
import type { AgentRunner } from './types'
import type { AgentContext, AgentOutput, AgentRole } from '../agents/types'
import type { EngineeringTask } from '../contracts'
import { InMemoryFactoryEventBus } from '../events'

/**
 * V1.6 controlled-execution lever + repair wiring (2026-09-19, gobo lesson).
 *
 * - checkContractGate reports missing required files.
 * - a coder failure retries via the repair loop (repair.started emitted)
 *   instead of blocking at the coder stage with 0 repairs.
 * - a passing tester with files still missing triggers the contract gate
 *   repair instead of proceeding to review/completion.
 *
 * Run: npx tsx factory/orchestrator/contract-gate-test.ts
 */

class ScriptedRunner implements AgentRunner {
  private calls = 0
  constructor(
    private readonly roleId: string,
    private readonly script: (call: number) => AgentOutput,
  ) {}
  async run(role: AgentRole, _context: AgentContext): Promise<AgentOutput> {
    this.calls += 1
    return this.script(this.calls)
  }
}

function okOutput(role: AgentRole, summary: string): AgentOutput {
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

function baseTask(workspace: string, requiredFiles: string[] = []): EngineeringTask {
  return {
    id: 'contract-gate-test',
    workspace,
    objective: 'test',
    role: 'backend',
    stack: 'node',
    constraints: [],
    acceptanceCriteria: [],
    acceptance: { requiredFiles },
  }
}

async function main(): Promise<void> {
  // 1. Gate detects missing files.
  const temp = await mkdtemp(join(tmpdir(), 'contract-gate-'))
  try {
    await mkdir(join(temp, 'server'), { recursive: true })
    await writeFile(join(temp, 'server', 'auth.js'), 'export {}\n', 'utf8')
    const task = baseTask(temp, ['server/auth.js', 'server/notes.js'])
    assert.deepEqual(checkContractGate(task), ['server/notes.js'])
    await writeFile(join(temp, 'server', 'notes.js'), 'export {}\n', 'utf8')
    assert.deepEqual(checkContractGate(task), [])
    assert.deepEqual(checkContractGate(baseTask(temp, [])), [])

    // 2. Coder failure retries instead of terminal block.
    const bus = new InMemoryFactoryEventBus()
    const coder = new ScriptedRunner('coder', (call) =>
      call === 1
        ? {
            role: 'coder',
            summary: 'first attempt failed',
            findings: [],
            recommendations: [],
            blockingIssues: ['DSH host verification failed: node --test 7/7 fail'],
          }
        : { role: 'coder', summary: 'second attempt ok', findings: [], recommendations: [], blockingIssues: [] },
    )
    const pass = new ScriptedRunner('pass', (call) => ({ role: 'x', summary: `ok ${call}`, findings: [], recommendations: [], blockingIssues: [] }) as AgentOutput)
    void pass
    const dispatcher = new DefaultRoleRunnerDispatcher(
      new Map([
        ['architect', { run: async (role: AgentRole) => okOutput(role, 'a') }],
        ['planner', { run: async (role: AgentRole) => okOutput(role, 'p') }],
        ['coder', coder],
        ['tester', { run: async (role: AgentRole) => okOutput(role, 't') }],
        ['reviewer', { run: async (role: AgentRole) => okOutput(role, 'r') }],
      ]),
    )
    const orchestrator = new FactoryOrchestrator(undefined, dispatcher, { eventSink: bus, maxRepairAttempts: 3 })
    const result = await orchestrator.run(baseTask(temp, []))
    assert.equal(result.status, 'completed', JSON.stringify(result.blockingIssues))
    assert.equal(result.repairAttempts.length, 1)
    assert.deepEqual(result.repairAttempts[0].reason, ['Coder stage failed.'])
    const types = (await bus.list('contract-gate-test')).map((e) => e.type)
    assert.ok(types.includes('repair.started'), 'coder failure must emit repair.started')

    // 3. Contract gate blocks premature completion.
    const bus2 = new InMemoryFactoryEventBus()
    const dispatcher2 = new DefaultRoleRunnerDispatcher(
      new Map([
        ['architect', { run: async (role: AgentRole) => okOutput(role, 'a') }],
        ['planner', { run: async (role: AgentRole) => okOutput(role, 'p') }],
        ['coder', { run: async (role: AgentRole) => okOutput(role, 'c') }],
        ['tester', { run: async (role: AgentRole) => okOutput(role, 't') }],
        ['reviewer', { run: async (role: AgentRole) => okOutput(role, 'r') }],
      ]),
    )
    const orchestrator2 = new FactoryOrchestrator(undefined, dispatcher2, { eventSink: bus2, maxRepairAttempts: 0 })
    const missingTask: EngineeringTask = {
      ...baseTask(temp, ['server/notes.js', 'server/does-not-exist.js']),
      id: 'contract-gate-test',
    }
    const gated = await orchestrator2.run(missingTask)
    assert.equal(gated.status, 'failed', 'gate failure must not complete')
    assert.equal(gated.repairAttempts.length, 1)
    assert.deepEqual(gated.repairAttempts[0].reason, ['Contract gate failed.'])

    console.log('CONTRACT GATE TEST: PASS')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
