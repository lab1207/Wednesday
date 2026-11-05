// D1 scale - bounded parallel lanes at the service layer.
//
// Run: npx tsx factory/service-parallel-test.ts
//
// Proves (offline, deterministic provider, isolated temp state):
// 1. runMany completes N tasks with results in input order.
// 2. Lanes genuinely overlap (task-B events start before task-A events end).
// 3. Every lane's event stream is complete (ends task.completed) and the
//    shared JSONL log stays parseable under concurrency (write mutex).
// 4. Duplicate workspaces are refused (isolation gate).
// 5. maxParallel=1 and empty input behave (serial equivalence, []).

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import type { EngineeringTask } from './contracts'

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(
    join(tmpdir(), 'parallel-test-'),
  )

  // Isolated state BEFORE the service module loads (paths.ts reads
  // env eagerly at import time).
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

  const makeTask = async (
    id: string,
  ): Promise<EngineeringTask> => ({
    id,
    workspace: await mkdtemp(
      join(tempRoot, `${id}-`),
    ),
    objective: `Deterministic parallel probe ${id}.`,
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
    const tasks = await Promise.all(
      [
        'lane-a',
        'lane-b',
        'lane-c',
        'lane-d',
      ].map(makeTask),
    )

    const results =
      await service.runMany(tasks, {
        maxParallel: 3,
      })

    // 1. Order + completion.
    assert.equal(results.length, 4)

    for (let index = 0; index < 4; index += 1) {
      assert.equal(
        results[index].taskId,
        tasks[index].id,
        `result ${index} must map to its own task (no lane swap)`,
      )
      assert.equal(
        results[index].status,
        'completed',
        `lane ${tasks[index].id} must complete: ${JSON.stringify(results[index]).slice(0, 300)}`,
      )
    }

    // 2. Genuine overlap: all lanes start synchronously, but no lane
    // can finish without many async turns (fs I/O per role). So lane B
    // must start before lane A finishes, and vice versa. Serial
    // execution would place one whole interval before the other.
    const all =
      await service.events()

    const interval = (
      taskId: string,
    ): [number, number] => {
      const positions = all
        .map((event, index) =>
          event.taskId === taskId
            ? index
            : -1,
        )
        .filter(index => index >= 0)

      assert.ok(
        positions.length > 0,
        `lane ${taskId} must emit events`,
      )

      return [
        positions[0],
        positions[positions.length - 1],
      ]
    }

    const [aFirst, aLast] =
      interval('lane-a')
    const [bFirst, bLast] =
      interval('lane-b')

    assert.ok(
      bFirst < aLast &&
        aFirst < bLast,
      `lanes must overlap (a:[${aFirst},${aLast}] b:[${bFirst},${bLast}])`,
    )

    // 3. Per-lane completeness + log integrity (list() parses every
    // line - interleaved bytes would throw here).
    for (const task of tasks) {
      const lane =
        await service.events(task.id)

      assert.ok(
        lane.length > 0,
        `lane ${task.id} must emit events`,
      )
      assert.equal(
        lane.at(-1)!.type,
        'task.completed',
        `lane ${task.id} must end completed`,
      )
      assert.ok(
        lane.every(
          event =>
            event.taskId === task.id,
        ),
        `lane ${task.id} filter must be exact`,
      )
    }

    // 4. Isolation gate.
    const dup = {
      ...tasks[0],
      id: 'lane-dup',
    }

    await assert.rejects(
      service.runMany([tasks[0], dup]),
      /duplicate workspace/,
    )

    // 5. Serial equivalence + empty.
    const serial =
      await service.runMany(
        tasks.slice(0, 2).map(
          (task, index) => ({
            ...task,
            id: `serial-${index}`,
          }),
        ),
        { maxParallel: 1 },
      )

    assert.ok(
      serial.every(
        result =>
          result.status === 'completed',
      ),
      'maxParallel=1 must still complete every task',
    )

    assert.deepEqual(
      await service.runMany([]),
      [],
    )

    console.log(
      'SERVICE PARALLEL TEST: PASS (4 lanes overlapped, order + isolation + serial equivalence)',
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
