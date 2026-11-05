// D2 scale guardrails - abort-one/all isolation + shared-budget guard.
//
// Run: npx tsx factory/service-guardrails-test.ts
//
// Proves (offline, deterministic provider, isolated temp state):
// 1. Abort-one: a pre-aborted lane fails alone; its siblings complete
//    and runMany still resolves with one result per task.
// 2. Abort-all: a shared pre-aborted signal fails every lane, resolves.
// 3. laneBudgetExceeded (pure): trips over the token cap, holds at/under;
//    spend trips on known pricing, stays fail-open on unknown pricing.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import type { EngineeringTask } from './contracts'
import type { UsageRecord } from './model-router/usage'

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(
    join(tmpdir(), 'guardrails-test-'),
  )

  process.env.FACTORY_EXECUTION_MODE =
    'deterministic'
  process.env.WEDNESDAY_STATE_HOME = join(
    tempRoot,
    'state',
  )
  process.env.FACTORY_EVENTS_PATH = join(
    tempRoot,
    'events.jsonl',
  )

  const {
    createFactoryService,
    laneBudgetExceeded,
  } = await import('./service')

  const service =
    await createFactoryService()

  const makeTask = async (
    id: string,
  ): Promise<EngineeringTask> => ({
    id,
    workspace: await mkdtemp(
      join(tempRoot, `${id}-`),
    ),
    objective: `Deterministic guardrails probe ${id}.`,
    role: 'backend',
    stack: 'python',
    constraints: [],
    acceptanceCriteria: [],
    acceptance: {
      requiredFiles: [],
    },
    verification: {
      setupCommands: [],
      testCommands: [],
    },
  })

  try {
    // 1. Abort-one.
    const trio = await Promise.all(
      ['g-a', 'g-b', 'g-c'].map(
        makeTask,
      ),
    )

    const deadB =
      new AbortController()
    deadB.abort('test aborts lane B')

    const mixed =
      await service.runMany(trio, {
        maxParallel: 3,
        signals: [
          undefined,
          deadB.signal,
          undefined,
        ],
      })

    assert.equal(mixed.length, 3)
    assert.equal(
      mixed[0].status,
      'completed',
      'lane A must survive lane B abort',
    )
    assert.notEqual(
      mixed[1].status,
      'completed',
      'pre-aborted lane B must not complete',
    )
    assert.equal(
      mixed[1].taskId,
      'g-b',
      'lane B failure must keep its own task id',
    )
    assert.equal(
      mixed[2].status,
      'completed',
      'lane C must survive lane B abort',
    )

    // 2. Abort-all.
    const pair = await Promise.all(
      ['g-d', 'g-e'].map(makeTask),
    )

    const deadAll =
      new AbortController()
    deadAll.abort('test aborts everything')

    const allDead =
      await service.runMany(pair, {
        maxParallel: 2,
        signal: deadAll.signal,
      })

    assert.ok(
      allDead.every(
        result =>
          result.status !==
          'completed',
      ),
      'shared abort must fail every lane yet still resolve',
    )

    // 3. Pure budget guard.
    const records: UsageRecord[] = [
      {
        provider: 'p',
        model: 'm',
        calls: 2,
        promptTokens: 60,
        completionTokens: 40,
      },
    ]

    assert.equal(
      laneBudgetExceeded(records, {
        maxTokens: 100,
      }),
      undefined,
      'at-cap must hold',
    )
    assert.match(
      laneBudgetExceeded(records, {
        maxTokens: 99,
      }) ?? '',
      /token budget exceeded/,
      'over-cap must trip with a reason',
    )
    assert.equal(
      laneBudgetExceeded(records, {}),
      undefined,
      'no caps must hold',
    )

    const freeRecords: UsageRecord[] = [
      {
        provider: 'openrouter',
        model: 'openrouter/free',
        calls: 1,
        promptTokens: 5000,
        completionTokens: 5000,
      },
    ]

    // The free model costs exactly 0; a negative cap proves the spend
    // comparison fires on known pricing (no nonzero-priced model is
    // listed in PRICE_PER_MILLION_TOKENS yet).
    assert.match(
      laneBudgetExceeded(freeRecords, {
        maxUsd: -0.5,
      }) ?? '',
      /spend budget exceeded/,
      'known pricing must enforce spend',
    )
    assert.equal(
      laneBudgetExceeded(records, {
        maxUsd: 0,
      }),
      undefined,
      'unknown pricing must stay fail-open on spend',
    )

    console.log(
      'SERVICE GUARDRAILS TEST: PASS (abort-one/all isolated, budget guard trips + fail-open)',
    )
  } finally {
    await rm(tempRoot, {
      recursive: true,
      force: true,
    })
  }
}

void main()
  .catch(
    (error: unknown) => {
      console.error(error)
      process.exitCode = 1
    },
  )
  .finally(() => {
    // Same boundary rule as hermes.ts: the undisposed cordis Context
    // inside createFactoryService() keeps the event loop alive.
    process.exit(
      process.exitCode ?? 0,
    )
  })
