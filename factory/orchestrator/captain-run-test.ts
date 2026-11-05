/**
 * Integration test for the captain fallback (2026-09-27). Stub runners
 * + stub prober/judge prove: ceiling runs one attempt per lens, a
 * 50%-partial coder is nominated captain, the guidance lands where the
 * coder sees it and the run converges; no qualifier falls through to
 * the diagnoser; a throwing prober fails open to history. No models,
 * no network.
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
    acceptanceCriteria: ['a', 'b', 'c', 'd'],
  }
}

const DIAGNOSIS = [
  'The coder repeats the same write without checking the file landed.',
  '1. Write the missing file before any other file.',
  '2. Read the file back after writing.',
].join('\n')

async function main(): Promise<void> {
  const savedExpansion = process.env.FACTORY_EXPANSION
  const savedCaptain = process.env.FACTORY_CAPTAIN
  process.env.FACTORY_EXPANSION = 'solo'
  process.env.FACTORY_CAPTAIN = '1'

  try {
    // 1. A 50%-partial coder is nominated; guidance lands; run converges.
    {
      let coderCalls = 0
      const sawCaptain: boolean[] = []
      const probed: string[] = []
      const coder = async (role: AgentRole, context: AgentContext): Promise<AgentOutput> => {
        coderCalls += 1
        sawCaptain.push(
          context.previousOutputs.some(
            output =>
              output.role === 'planner' &&
              output.summary.includes('Captain coder nominated'),
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
      const root = mkdtempSync(join(tmpdir(), 'wed-captain-'))
      const workspace = join(root, 'task')
      mkdirSync(workspace, { recursive: true })

      try {
        const orchestrator = new FactoryOrchestrator(undefined, dispatcher, {
          eventSink: new InMemoryFactoryEventBus(),
          maxRepairAttempts: 1,
          recoveryRounds: 1,
          captainProber: async (lens: string, prompt: string) => {
            probed.push(lens)
            assert.ok(prompt.includes('Build a small widget.'))
            return `${lens} diagnostic attempt`
          },
          captainJudge: async (lens: string) => {
            if (lens === 'coder') {
              return { passed: false, requiredChanges: ['c', 'd'] }
            }
            return { passed: false, requiredChanges: ['a', 'b', 'c', 'd'] }
          },
        })
        const result = await orchestrator.run(makeTask(workspace, 'captain-test-001'))
        assert.equal(result.status, 'completed')
        assert.deepEqual(probed, ['planner', 'coder', 'vision'])
        assert.equal(coderCalls, 3, `two failures then a recovered pass, got ${coderCalls} calls`)
        assert.deepEqual(sawCaptain, [false, false, true])
        assert.ok(
          result.repairAttempts.some(attempt =>
            attempt.reason.some(reason => reason.includes('Captain coder nominated')),
          ),
          'the nomination must stay visible in history',
        )
        console.log('CAPTAIN: 50%-partial coder nominated, crew re-rolled, run converged')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    // 2. No qualifier → diagnoser path still runs.
    {
      const coder = async (role: AgentRole): Promise<AgentOutput> => {
        if ((coder as { calls?: number }).calls === undefined) {
          (coder as { calls?: number }).calls = 0
        }
        const calls = ((coder as { calls?: number }).calls as number) + 1
        ;(coder as { calls?: number }).calls = calls
        if (calls <= 2) {
          return {
            ...cleanOutput(role.id, `coder failed ${calls}`),
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
      const root = mkdtempSync(join(tmpdir(), 'wed-captainfall-'))
      const workspace = join(root, 'task')
      mkdirSync(workspace, { recursive: true })

      try {
        let diagnosed = 0
        const orchestrator = new FactoryOrchestrator(undefined, dispatcher, {
          eventSink: new InMemoryFactoryEventBus(),
          maxRepairAttempts: 1,
          recoveryRounds: 1,
          captainProber: async () => 'weak attempt',
          captainJudge: async () => ({
            passed: false,
            requiredChanges: ['a', 'b', 'c', 'd'],
          }),
          diagnoser: async () => {
            diagnosed += 1
            return DIAGNOSIS
          },
        })
        const result = await orchestrator.run(makeTask(workspace, 'captain-test-002'))
        assert.equal(result.status, 'completed')
        assert.equal(diagnosed, 1, 'no qualifier must fall through to the diagnoser')
        assert.ok(
          result.repairAttempts.every(attempt =>
            attempt.reason.every(reason => !reason.includes('nominated')),
          ),
          'no nomination without a qualifier',
        )
        console.log('CAPTAIN FAIL-OPEN: no qualifier falls through to the diagnoser')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    // 3. Throwing prober fails open to the historical failure.
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
      const root = mkdtempSync(join(tmpdir(), 'wed-captainthrow-'))
      const workspace = join(root, 'task')
      mkdirSync(workspace, { recursive: true })

      try {
        const orchestrator = new FactoryOrchestrator(undefined, dispatcher, {
          eventSink: new InMemoryFactoryEventBus(),
          maxRepairAttempts: 1,
          recoveryRounds: 1,
          captainProber: async (): Promise<string> => {
            throw new Error('lens down')
          },
        })
        const result = await orchestrator.run(makeTask(workspace, 'captain-test-003'))
        assert.equal(result.status, 'failed')
        assert.ok(
          result.blockingIssues.some(issue => issue.includes('after coder failure')),
          `original ceiling message must survive, got ${JSON.stringify(result.blockingIssues)}`,
        )
        console.log('CAPTAIN FAIL-OPEN: throwing prober keeps historical failure')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  } finally {
    if (savedExpansion === undefined) delete process.env.FACTORY_EXPANSION
    else process.env.FACTORY_EXPANSION = savedExpansion
    if (savedCaptain === undefined) delete process.env.FACTORY_CAPTAIN
    else process.env.FACTORY_CAPTAIN = savedCaptain
  }

  console.log('CAPTAIN EXECUTION TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
