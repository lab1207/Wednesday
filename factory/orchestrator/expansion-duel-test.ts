/**
 * Integration test for expansion execution (2026-09-23). Stub runners +
 * real temp workspaces prove: duel lanes race isolated (loser files never
 * leak into the task workspace, lane dirs cleaned), the tester picks the
 * winning lane, vote majority passes, unanimous-fail repairs then fails
 * at the ceiling. No models, no network.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

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
    acceptanceCriteria: ['lane.txt exists'],
  }
}

function dispatcherFor(
  coder: AgentRunner['run'],
  tester: AgentRunner['run'],
  reviewer: AgentRunner['run'],
) {
  const pass = async (role: AgentRole): Promise<AgentOutput> =>
    cleanOutput(role.id, `${role.id} ok`)
  const wrap = (fn: AgentRunner['run']): AgentRunner => ({ run: fn })
  return new DefaultRoleRunnerDispatcher(
    new Map([
      ['architect', wrap(pass)],
      ['planner', wrap(pass)],
      ['coder', wrap(coder)],
      ['tester', wrap(tester)],
      ['reviewer', wrap(reviewer)],
    ]),
  )
}

function passingReviewer(): AgentRunner['run'] {
  return async (role: AgentRole): Promise<AgentOutput> => ({
    ...cleanOutput(role.id, 'reviewer pass'),
    review: { verdict: 'pass', summary: 'looks good', findings: [], requiredChanges: [], evidence: [] },
  })
}

/** Coder/tester pair where lane 1 wins (duel) — suffix decides, order never matters. */
function duelingPair(calls: string[]) {
  const coder = async (role: AgentRole, context: AgentContext): Promise<AgentOutput> => {
    calls.push(`coder:${basename(context.workspace)}`)
    const lane = basename(context.workspace).endsWith('-l1') ? 'good-lane-1' : 'bad-lane-0'
    writeFileSync(join(context.workspace, 'lane.txt'), lane)
    return cleanOutput(role.id, `coder wrote ${lane}`)
  }
  const tester = async (role: AgentRole, context: AgentContext): Promise<AgentOutput> => {
    calls.push(`tester:${basename(context.workspace)}`)
    const content = readFileSync(join(context.workspace, 'lane.txt'), 'utf8')
    const output = cleanOutput(role.id, 'tester graded lane')
    if (!content.includes('good')) {
      output.blockingIssues = ['lane output not good']
    }
    return output
  }
  return { coder, tester }
}

/** Coder/tester pair that always passes (vote scenarios). */
function passingPair() {
  const coder = async (role: AgentRole, context: AgentContext): Promise<AgentOutput> => {
    writeFileSync(join(context.workspace, 'lane.txt'), 'good')
    return cleanOutput(role.id, 'coder ok')
  }
  const tester = async (role: AgentRole): Promise<AgentOutput> =>
    cleanOutput(role.id, 'tester ok')
  return { coder, tester }
}

async function main(): Promise<void> {
  const savedExpansion = process.env.FACTORY_EXPANSION
  const savedDuel = process.env.FACTORY_DUEL_WIDTH
  const savedVote = process.env.FACTORY_VOTE_WIDTH

  try {
    // 1. Duel: two lanes race, winner (lane 1) lands, loser never leaks.
    {
      process.env.FACTORY_EXPANSION = 'duel'
      const calls: string[] = []
      const pair = duelingPair(calls)
      const root = mkdtempSync(join(tmpdir(), 'wed-duel-'))
      const workspace = join(root, 'task')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'seed.txt'), 'seed')

      try {
        const orchestrator = new FactoryOrchestrator(undefined, dispatcherFor(pair.coder, pair.tester, passingReviewer()), {
          eventSink: new InMemoryFactoryEventBus(),
        })
        const result = await orchestrator.run(makeTask(workspace, 'duel-test-001'))
        assert.equal(result.status, 'completed')
        assert.deepEqual(result.repairAttempts, [])
        assert.equal(readFileSync(join(workspace, 'lane.txt'), 'utf8'), 'good-lane-1')
        assert.equal(
          calls.filter(call => call.startsWith('coder:')).length,
          2,
          `two coder lanes must run, got ${JSON.stringify(calls)}`,
        )
        const leftovers = readdirSync(root).filter(name => name.includes('.duel-'))
        assert.deepEqual(leftovers, [], `lane dirs must be cleaned, got ${JSON.stringify(leftovers)}`)
        console.log('DUEL LANES: 2 raced, winner landed, losers cleaned')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    // 2. Vote: 2 pass + 1 fail → majority passes, run completes.
    {
      process.env.FACTORY_EXPANSION = 'vote'
      let ballots = 0
      const reviewer = async (role: AgentRole): Promise<AgentOutput> => {
        ballots += 1
        const verdict = ballots < 3 ? 'pass' : 'fail'
        return {
          ...cleanOutput(role.id, `ballot ${ballots}: ${verdict}`),
          review: { verdict, summary: verdict, findings: [], requiredChanges: verdict === 'fail' ? ['fix it'] : [], evidence: [] },
        }
      }
      const root = mkdtempSync(join(tmpdir(), 'wed-vote-'))
      const workspace = join(root, 'task')
      mkdirSync(workspace, { recursive: true })
      const pair = passingPair()

      try {
        const orchestrator = new FactoryOrchestrator(undefined, dispatcherFor(pair.coder, pair.tester, reviewer), {
          eventSink: new InMemoryFactoryEventBus(),
        })
        const result = await orchestrator.run(makeTask(workspace, 'vote-test-001'))
        assert.equal(result.status, 'completed')
        assert.equal(ballots, 3, `three ballots must run, got ${ballots}`)
        console.log('VOTE MAJORITY: 2-1 passes')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    // 3. Vote unanimous fail → repair recorded, ceiling stops the run.
    {
      process.env.FACTORY_EXPANSION = 'vote'
      const reviewer = async (role: AgentRole): Promise<AgentOutput> => ({
        ...cleanOutput(role.id, 'ballot fail'),
        review: { verdict: 'fail', summary: 'bad', findings: [], requiredChanges: ['fix it'], evidence: [] },
      })
      const root = mkdtempSync(join(tmpdir(), 'wed-votefail-'))
      const workspace = join(root, 'task')
      mkdirSync(workspace, { recursive: true })
      const pair = passingPair()

      try {
        const orchestrator = new FactoryOrchestrator(
          undefined,
          dispatcherFor(pair.coder, pair.tester, reviewer),
          { eventSink: new InMemoryFactoryEventBus(), maxRepairAttempts: 0 },
        )
        const result = await orchestrator.run(makeTask(workspace, 'vote-test-002'))
        assert.equal(result.status, 'failed')
        assert.ok(
          result.repairAttempts.some(attempt => attempt.reason.some(reason => reason.includes('Reviewer vote'))),
          `vote rejection must be recorded, got ${JSON.stringify(result.repairAttempts)}`,
        )
        console.log('VOTE FAIL: 0-3 repairs then stops at ceiling')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    // 4. Duel wipeout: every failed lane burns its own repair entry
    // (locked engine semantic: each failed try is recorded).
    {
      process.env.FACTORY_EXPANSION = 'duel'
      const failingCoder = async (role: AgentRole): Promise<AgentOutput> => ({
        ...cleanOutput(role.id, 'lane failed'),
        blockingIssues: ['nothing works'],
      })
      const root = mkdtempSync(join(tmpdir(), 'wed-duelwipe-'))
      const workspace = join(root, 'task')
      mkdirSync(workspace, { recursive: true })
      const pair = passingPair()

      try {
        const orchestrator = new FactoryOrchestrator(
          undefined,
          dispatcherFor(failingCoder, pair.tester, passingReviewer()),
          { eventSink: new InMemoryFactoryEventBus(), maxRepairAttempts: 1 },
        )
        const result = await orchestrator.run(makeTask(workspace, 'duel-test-002'))
        assert.equal(result.status, 'failed')
        assert.equal(
          result.repairAttempts.length,
          4,
          `two wipeout rounds must record four lane entries, got ${JSON.stringify(result.repairAttempts.map(a => a.reason))}`,
        )
        assert.ok(
          result.repairAttempts.every(attempt =>
            attempt.reason.some(reason => reason.includes('Duel lane failed')),
          ),
          'every wipeout entry names its lane',
        )
        console.log('DUEL WIPEOUT: 2 rounds x 2 lanes = 4 entries, ceiling stops run')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    // 5. Mass lanes: width 6 races, winner lands (mechanism scales;
    // wall-clock throughput needs a model fleet behind the route).
    {
      process.env.FACTORY_EXPANSION = 'duel'
      process.env.FACTORY_DUEL_WIDTH = '6'
      const calls: string[] = []
      const coder = async (role: AgentRole, context: AgentContext): Promise<AgentOutput> => {
        calls.push(`coder:${basename(context.workspace)}`)
        writeFileSync(join(context.workspace, 'lane.txt'), 'good')
        return cleanOutput(role.id, 'coder ok')
      }
      const root = mkdtempSync(join(tmpdir(), 'wed-duelmass-'))
      const workspace = join(root, 'task')
      mkdirSync(workspace, { recursive: true })
      const pair = passingPair()

      try {
        const orchestrator = new FactoryOrchestrator(undefined, dispatcherFor(coder, pair.tester, passingReviewer()), {
          eventSink: new InMemoryFactoryEventBus(),
        })
        const result = await orchestrator.run(makeTask(workspace, 'duel-test-003'))
        assert.equal(result.status, 'completed')
        assert.equal(
          calls.filter(call => call.startsWith('coder:')).length,
          6,
          `six lanes must run, got ${JSON.stringify(calls)}`,
        )
        const lanes = new Set(calls.map(call => call.split(':')[1]))
        assert.equal(lanes.size, 6, 'lanes must be isolated workspaces')
        const leftovers = readdirSync(root).filter(name => name.includes('.duel-'))
        assert.deepEqual(leftovers, [])
        console.log('DUEL MASS: 6 raced isolated, winner landed, cleaned')
      } finally {
        delete process.env.FACTORY_DUEL_WIDTH
        rmSync(root, { recursive: true, force: true })
      }
    }
  } finally {
    if (savedExpansion === undefined) delete process.env.FACTORY_EXPANSION
    else process.env.FACTORY_EXPANSION = savedExpansion
    if (savedDuel === undefined) delete process.env.FACTORY_DUEL_WIDTH
    else process.env.FACTORY_DUEL_WIDTH = savedDuel
    if (savedVote === undefined) delete process.env.FACTORY_VOTE_WIDTH
    else process.env.FACTORY_VOTE_WIDTH = savedVote
  }

  console.log('EXPANSION EXECUTION TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
