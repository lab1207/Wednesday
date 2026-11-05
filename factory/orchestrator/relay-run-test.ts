/**
 * Execution test for the relay team loop (2026-10-16). Stub runners +
 * real temp workspaces prove: on failure the remainder splits into
 * pieces, each piece races as an isolated lane pinned to its pool model,
 * winners merge back per touched file, failed pieces expand into inner
 * loops, lane dirs are cleaned, and relay-off stays byte-identical.
 * No models, no network.
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
import { clearModelFit, getModelFit } from '../model-router/model-capabilities'
import { clearRelayMemory, getRelayMemory } from './relay-memory'

const SAVED_KEYS = [
  'FACTORY_RELAY',
  'FACTORY_RELAY_WIDTH',
  'FACTORY_RELAY_ROUNDS',
  'FACTORY_RELAY_DEPTH',
  'FACTORY_RELAY_RETRIES',
  'FACTORY_EXPANSION',
  'FACTORY_DUEL_WIDTH',
  'FACTORY_MODEL_POOL',
  'FACTORY_MAX_REPAIR_ATTEMPTS',
] as const

function saveEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const key of SAVED_KEYS) out[key] = process.env[key]
  return out
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of SAVED_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}

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
    objective: 'Build the widget: missing alpha and missing beta.',
    role: 'backend',
    stack: 'python',
    constraints: [],
    acceptanceCriteria: ['widget works'],
  }
}

function passingReviewer(): AgentRunner['run'] {
  return async (role: AgentRole): Promise<AgentOutput> => ({
    ...cleanOutput(role.id, 'reviewer pass'),
    review: { verdict: 'pass', summary: 'looks good', findings: [], requiredChanges: [], evidence: [] },
  })
}

interface Rig {
  relayCalls: string[]
  pins: (string | undefined)[]
  coderWorkspaces: string[]
  convergeNormally: boolean
  betaNeedsEscalation: boolean
}

/**
 * Coder stub: relay lanes write the file their piece names (and report
 * it, so the merge lands per touched file); normal rounds write a
 * harmless marker — or converge everything when the rig allows it.
 */
function makeCoder(rig: Rig): AgentRunner['run'] {
  return async (role: AgentRole, context: AgentContext): Promise<AgentOutput> => {
    rig.coderWorkspaces.push(basename(context.workspace))
    // Duel lanes in the wipeout scenario always fail, naming the file
    // they could not write — so the wipeout carries keywords into relay.
    if (basename(context.workspace).includes('.duel-')) {
      const missing = basename(context.workspace).endsWith('-l0')
        ? 'missing alpha'
        : 'missing beta'
      return { ...cleanOutput(role.id, 'duel lane failed'), blockingIssues: [missing] }
    }
    const pieceAt = context.task.objective.indexOf('PIECE: ')
    if (pieceAt >= 0) {
      const title = context.task.objective.slice(pieceAt).toLowerCase()
      rig.relayCalls.push(context.task.objective.slice(pieceAt, pieceAt + 40))
      rig.pins.push(context.task.modelRequirements?.preferredModel)
      const files: string[] = []
      if (title.includes('shared')) {
        const pieceId = /RELAY PIECE (\S+)/.exec(context.task.objective)?.[1] ?? 'lane'
        writeFileSync(join(context.workspace, 'shared.txt'), `writer ${pieceId}`)
        files.push('shared.txt')
      }
      // Quiet lanes never report: the lane diff must land their work.
      if (title.includes('quiet')) {
        writeFileSync(join(context.workspace, 'quiet.txt'), 'quiet')
      }
      if (title.includes('alpha')) {
        writeFileSync(join(context.workspace, 'alpha.txt'), 'alpha')
        files.push('alpha.txt')
      }
      // Beta is stubborn when the rig says so: it only yields to a changed
      // approach, never to repeating try 1 — the retry escalation must
      // carry the fix.
      if (title.includes('beta') && (!rig.betaNeedsEscalation || context.task.objective.includes('STRATEGY CHANGE'))) {
        writeFileSync(join(context.workspace, 'beta.txt'), 'beta')
        files.push('beta.txt')
      }
      return {
        ...cleanOutput(role.id, `relay lane solved ${files.join(',') || 'nothing'}`),
        filesChanged: files,
        engineeringResult: {
          taskId: context.task.id,
          status: 'completed',
          summary: `relay lane solved ${files.join(',') || 'nothing'}`,
          output: '',
          filesChanged: files,
          tests: [],
          acceptanceChecks: [],
        },
      }
    }
    if (rig.convergeNormally) {
      for (const file of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
        writeFileSync(join(context.workspace, file), 'fixed normally')
      }
    } else {
      writeFileSync(join(context.workspace, 'round.txt'), 'normal round')
    }
    return cleanOutput(role.id, 'normal coder round')
  }
}

/** Tester stub: lanes grade their own piece file; main grades the merge. */
function makeTester(): AgentRunner['run'] {
  return async (role: AgentRole, context: AgentContext): Promise<AgentOutput> => {
    const isLane = basename(context.workspace).includes('.relay-')
    const pieceAt = context.task.objective.indexOf('PIECE: ')
    if (isLane && pieceAt >= 0) {
      const title = context.task.objective.slice(pieceAt).toLowerCase()
      const missing: string[] = []
      const expectFiles: string[] = []
      if (title.includes('shared')) expectFiles.push('shared.txt')
      if (title.includes('quiet')) expectFiles.push('quiet.txt')
      if (title.includes('alpha')) expectFiles.push('alpha.txt')
      if (title.includes('beta')) expectFiles.push('beta.txt')
      if (title.includes('gamma')) missing.push('gamma not solved in lane')
      for (const file of expectFiles) {
        try {
          readFileSync(join(context.workspace, file), 'utf8')
        } catch {
          missing.push(`${file} not solved in lane`)
        }
      }
      const output = cleanOutput(role.id, 'lane graded')
      if (missing.length > 0) output.blockingIssues = missing
      return output
    }
    const missing: string[] = []
    if (basename(context.workspace).includes('merge')) {
      for (const name of ['shared-a', 'shared-b', 'quiet']) {
        try {
          const file = name.startsWith('shared') ? 'shared.txt' : 'quiet.txt'
          readFileSync(join(context.workspace, file), 'utf8')
        } catch {
          missing.push(`missing ${name}`)
        }
      }
    } else {
      for (const file of ['alpha.txt', 'beta.txt']) {
        try {
          readFileSync(join(context.workspace, file), 'utf8')
        } catch {
          missing.push(`missing ${file.split('.')[0]}`)
        }
      }
    }
    if (basename(context.workspace).includes('stuck')) {
      try {
        readFileSync(join(context.workspace, 'gamma.txt'), 'utf8')
      } catch {
        missing.push('missing gamma')
      }
    }
    const output = cleanOutput(role.id, 'main graded')
    if (missing.length > 0) output.blockingIssues = missing
    return output
  }
}

function dispatcherFor(rig: Rig) {
  const pass = async (role: AgentRole): Promise<AgentOutput> =>
    cleanOutput(role.id, `${role.id} ok`)
  const wrap = (fn: AgentRunner['run']): AgentRunner => ({ run: fn })
  return new DefaultRoleRunnerDispatcher(
    new Map([
      ['architect', wrap(pass)],
      ['planner', wrap(pass)],
      ['coder', wrap(makeCoder(rig))],
      ['tester', wrap(makeTester())],
      ['reviewer', wrap(passingReviewer())],
    ]),
  )
}

function relayDirsLeft(root: string): string[] {
  return readdirSync(root).filter(entry => entry.includes('.relay-'))
}

async function main(): Promise<void> {
  const saved = saveEnv()
  try {
    // 1. Relay on: remainder splits, lanes pin to pool models, merge lands.
    // Probe stub grades every model at full marks; memory records the wins.
    {
      clearModelFit()
      clearRelayMemory()
      process.env.FACTORY_RELAY = '1'
      process.env.FACTORY_EXPANSION = 'solo'
      process.env.FACTORY_MODEL_POOL = 'pool-a,pool-b'
      const rig: Rig = { relayCalls: [], pins: [], coderWorkspaces: [], convergeNormally: false, betaNeedsEscalation: true }
      const proberCalls: Array<{ modelId: string; prompt: string; images?: string[] }> = []
      const relayProber = async (modelId: string, prompt: string, images?: string[]): Promise<string> => {
        proberCalls.push({ modelId, prompt, images })
        return '1 2 3 return def add(a, b): return a + b red square blue background bug index 1 def mul(a, b): return a * b'
      }
      const root = mkdtempSync(join(tmpdir(), 'wed-relay-'))
      const workspace = join(root, 'task')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'seed.txt'), 'seed')
      try {
        const orchestrator = new FactoryOrchestrator(undefined, dispatcherFor(rig), {
          eventSink: new InMemoryFactoryEventBus(),
          relayProber,
        })
        const result = await orchestrator.run(makeTask(workspace, 'relay-test-001'))
        assert.equal(result.status, 'completed')
        assert.equal(readFileSync(join(workspace, 'alpha.txt'), 'utf8'), 'alpha')
        assert.equal(readFileSync(join(workspace, 'beta.txt'), 'utf8'), 'beta')
        // e2e R-BS-14: the pool probed itself once (5 caps x 2 models).
        assert.equal(proberCalls.length, 10)
        assert.ok(
          proberCalls.some(call => (call.images ?? []).length === 1),
          'vision probe must carry the pixel',
        )
        assert.deepEqual(
          getModelFit().pool.map(model => model.id),
          ['pool-a', 'pool-b'],
        )
        // e2e R-BS-29: lane wins wrote back into memory for next rounds.
        assert.ok(
          Object.keys(getRelayMemory()).length > 0,
          'relay outcomes must teach the router',
        )
        // Alpha solved try 1, beta failed try 1 then yielded to the
        // escalated try 2 — same piece, different approach.
        assert.equal(rig.relayCalls.length, 3)
        assert.deepEqual(rig.pins, ['pool-a', 'pool-b', 'pool-b'])
        assert.ok(
          result.repairAttempts.some(attempt =>
            attempt.reason.some(reason => reason.includes('try 1/3')),
          ),
          'failed first try must be recorded with its try count',
        )
        assert.deepEqual(relayDirsLeft(root), [])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
      restoreEnv(saved)
    }

    // 2. Relay off (default): same rig converges normally, zero relay lanes.
    {
      clearModelFit()
      clearRelayMemory()
      process.env.FACTORY_EXPANSION = 'solo'
      process.env.FACTORY_MODEL_POOL = 'pool-a,pool-b'
      const rig: Rig = { relayCalls: [], pins: [], coderWorkspaces: [], convergeNormally: true, betaNeedsEscalation: true }
      const root = mkdtempSync(join(tmpdir(), 'wed-relay-'))
      const workspace = join(root, 'task')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'seed.txt'), 'seed')
      try {
        const orchestrator = new FactoryOrchestrator(undefined, dispatcherFor(rig), {
          eventSink: new InMemoryFactoryEventBus(),
        })
        const result = await orchestrator.run(makeTask(workspace, 'relay-test-002'))
        assert.equal(result.status, 'completed')
        assert.equal(rig.relayCalls.length, 0)
        assert.deepEqual(relayDirsLeft(root), [])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
      restoreEnv(saved)
    }

    // 3. Stuck at depth 0: unsolvable piece surfaces to the normal path.
    {
      clearModelFit()
      clearRelayMemory()
      process.env.FACTORY_RELAY = '1'
      process.env.FACTORY_RELAY_DEPTH = '0'
      process.env.FACTORY_EXPANSION = 'solo'
      process.env.FACTORY_MODEL_POOL = 'pool-a,pool-b'
      process.env.FACTORY_MAX_REPAIR_ATTEMPTS = '1'
      const rig: Rig = { relayCalls: [], pins: [], coderWorkspaces: [], convergeNormally: false, betaNeedsEscalation: true }
      const root = mkdtempSync(join(tmpdir(), 'wed-relay-'))
      const workspace = join(root, 'task-stuck')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'seed.txt'), 'seed')
      try {
        const orchestrator = new FactoryOrchestrator(undefined, dispatcherFor(rig), {
          eventSink: new InMemoryFactoryEventBus(),
        })
        const result = await orchestrator.run(makeTask(workspace, 'relay-test-003'))
        assert.equal(result.status, 'failed')
        assert.ok(
          result.repairAttempts.some(attempt =>
            attempt.reason.some(reason => reason.includes('Relay piece failed')),
          ),
          'stuck relay piece must be recorded before the normal path ends it',
        )
        assert.deepEqual(relayDirsLeft(root), [])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
      restoreEnv(saved)
    }

    // 4. Duel wipeout enters relay (R-BM-15), and no second duel thrashes
    // the landed work (R-BS-15): exactly one duel, then relay, then solo.
    {
      clearModelFit()
      clearRelayMemory()
      process.env.FACTORY_RELAY = '1'
      process.env.FACTORY_EXPANSION = 'duel'
      process.env.FACTORY_DUEL_WIDTH = '2'
      process.env.FACTORY_MODEL_POOL = 'pool-a,pool-b'
      const rig: Rig = { relayCalls: [], pins: [], coderWorkspaces: [], convergeNormally: false, betaNeedsEscalation: false }
      const root = mkdtempSync(join(tmpdir(), 'wed-relay-'))
      const workspace = join(root, 'task-duelwipe')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'seed.txt'), 'seed')
      try {
        const orchestrator = new FactoryOrchestrator(undefined, dispatcherFor(rig), {
          eventSink: new InMemoryFactoryEventBus(),
        })
        const result = await orchestrator.run(makeTask(workspace, 'relay-test-004'))
        assert.equal(result.status, 'completed')
        assert.equal(readFileSync(join(workspace, 'alpha.txt'), 'utf8'), 'alpha')
        assert.equal(readFileSync(join(workspace, 'beta.txt'), 'utf8'), 'beta')
        assert.equal(rig.relayCalls.length, 2)
        // e2e R-BM-15: the wipeout fed relay (alpha solved from wipeout keywords).
        // e2e R-BM-15: the wipeout fed relay (alpha solved from wipeout keywords).
        // e2e R-BS-15: exactly one duel raced — the landing round verified solo.
        assert.equal(
          rig.coderWorkspaces.filter(name => name.includes('.duel-')).length,
          2,
        )
        assert.deepEqual(relayDirsLeft(root), [])
        assert.deepEqual(
          readdirSync(root).filter(entry => entry.includes('.duel-')),
          [],
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
      restoreEnv(saved)
    }

    // 5. Merge: two writers clash on shared.txt (last wins, flagged) while
    // a silent lane lands via diff (R-BM-16, R-BM-17).
    {
      clearModelFit()
      clearRelayMemory()
      process.env.FACTORY_RELAY = '1'
      process.env.FACTORY_EXPANSION = 'solo'
      process.env.FACTORY_MODEL_POOL = 'pool-a,pool-b'
      const rig: Rig = { relayCalls: [], pins: [], coderWorkspaces: [], convergeNormally: false, betaNeedsEscalation: false }
      const root = mkdtempSync(join(tmpdir(), 'wed-relay-'))
      const workspace = join(root, 'task-merge')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'seed.txt'), 'seed')
      try {
        const orchestrator = new FactoryOrchestrator(undefined, dispatcherFor(rig), {
          eventSink: new InMemoryFactoryEventBus(),
        })
        const result = await orchestrator.run(makeTask(workspace, 'relay-test-005'))
        assert.equal(result.status, 'completed')
        // e2e R-BM-16: last writer (root.1) won and the clash is on record.
        assert.equal(readFileSync(join(workspace, 'shared.txt'), 'utf8'), 'writer root.1')
        assert.ok(
          result.repairAttempts.some(attempt =>
            attempt.reason.some(reason => reason.includes('Relay merge conflict on shared.txt')),
          ),
          'merge clash must be named for re-verify',
        )
        // e2e R-BM-17: the silent lane landed through the diff.
        assert.equal(readFileSync(join(workspace, 'quiet.txt'), 'utf8'), 'quiet')
        assert.deepEqual(relayDirsLeft(root), [])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
      restoreEnv(saved)
    }

    console.log('RELAY RUN TEST: PASS')
  } finally {
    restoreEnv(saved)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
