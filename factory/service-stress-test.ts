// D3 scale stress - parallel lanes at pressure, offline.
//
// Run: npx tsx factory/service-stress-test.ts
//
// Proves (offline, deterministic provider, isolated temp state):
// 1. 12 tasks over 4 lanes all complete, results in input order.
// 2. The shared JSONL log stays fully parseable at pressure (write
//    mutex under real interleave load) and every lane ends completed.
// 3. Lane recycling works across waves (12 tasks / 4 lanes).
// Wall time is reported, not asserted (machine-dependent).

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import type { EngineeringTask } from './contracts'

const TASK_COUNT = 12
const MAX_PARALLEL = 4

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(
    join(tmpdir(), 'stress-test-'),
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

  const { createFactoryService } =
    await import('./service')

  const service =
    await createFactoryService()

  try {
    const tasks: EngineeringTask[] =
      []

    for (
      let index = 0;
      index < TASK_COUNT;
      index += 1
    ) {
      const id = `stress-${String(index).padStart(2, '0')}`

      tasks.push({
        id,
        workspace: await mkdtemp(
          join(tempRoot, `${id}-`),
        ),
        objective: `Deterministic stress probe ${id}.`,
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
    }

    const started = Date.now()

    const results =
      await service.runMany(tasks, {
        maxParallel: MAX_PARALLEL,
      })

    const elapsedMs = Date.now() - started

    // 1. Every lane completes, order preserved.
    assert.equal(
      results.length,
      TASK_COUNT,
    )

    for (
      let index = 0;
      index < TASK_COUNT;
      index += 1
    ) {
      assert.equal(
        results[index].taskId,
        tasks[index].id,
      )
      assert.equal(
        results[index].status,
        'completed',
        `lane ${tasks[index].id}: ${JSON.stringify(results[index]).slice(0, 200)}`,
      )
    }

    // 2. Log integrity at pressure + per-lane completeness.
    const all =
      await service.events()

    assert.ok(
      all.length >= TASK_COUNT,
      `expected at least one event per task, saw ${all.length}`,
    )

    for (const task of tasks) {
      const lane =
        await service.events(task.id)

      assert.ok(lane.length > 0)
      assert.equal(
        lane.at(-1)!.type,
        'task.completed',
      )
    }

    console.log(
      `SERVICE STRESS TEST: PASS (${TASK_COUNT} tasks / ${MAX_PARALLEL} lanes / ${elapsedMs} ms, log intact)`,
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
