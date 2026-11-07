import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  EngineeringTask,
} from '../contracts'

/**
 * THE TEST MUST NOT WRITE INTO THE OPERATOR'S REAL STATE (2026-11-07).
 *
 * This suite used to run against the default state home, so every event
 * it produced landed in the operator's own
 * `~/.wednesday/state/events.jsonl` - hundreds of fake events from this
 * suite alone, mixed into the real history where the operator reads it.
 *
 * The state home is set BEFORE the modules that read it are imported:
 * `paths.ts` resolves the paths at import time, so setting the variable
 * after the import would be a no-op and the pollution would continue.
 */
const stateHome =
  mkdtempSync(
    join(
      tmpdir(),
      'events-service-test-',
    ),
  )

process.env.WEDNESDAY_STATE_HOME =
  stateHome
process.env.FACTORY_EVENTS_PATH =
  join(stateHome, 'events.jsonl')
process.env.HERMES_TASKS_PATH =
  join(stateHome, 'tasks.json')

const { INSTALL_ROOT } =
  await import('../paths')
const { createFactoryService } =
  await import('../service')

// The service is held here so the exit path can dispose it (see the bottom
// of this file).
let activeService: Awaited<ReturnType<typeof createFactoryService>> | undefined

async function main(): Promise<void> {
  process.env.FACTORY_EXECUTION_MODE =
    'deterministic'

  const service =
    await createFactoryService()
  activeService = service

  const task: EngineeringTask = {
    id:
      'event-service-test-001',

    workspace:
      join(INSTALL_ROOT, 'dsh-test-workspace'),

    objective:
      'Create factory-event-proof.txt containing exactly FACTORY_EVENT_OK.',

    role:
      'backend',

    stack:
      'test workspace',

    constraints: [
      'Keep the change minimal.',
    ],

    acceptanceCriteria: [
      'factory-event-proof.txt exists.',
      'factory-event-proof.txt contains exactly FACTORY_EVENT_OK.',
    ],

    acceptance: {
      requiredFiles: [
        'factory-event-proof.txt',
      ],
    },

    verification: {
      setupCommands: [],

      testCommands: [
        'python -c "from pathlib import Path; import sys; p=Path(\'factory-event-proof.txt\'); sys.exit(0 if p.exists() and p.read_text().strip() == \'FACTORY_EVENT_OK\' else 1)"',
      ],
    },

    modelRequirements: {
      capability:
        'coding',
    },
  }

  const result =
    await service.run(
      task,
    )

  const events =
    await service.events(
      task.id,
    )

  console.log(
    JSON.stringify(
      {
        result: {
          status:
            result.status,
          provider:
            result.provider,
          model:
            result.model,
        },

        events: events.map(
          event => ({
            type:
              event.type,
            role:
              event.role,
            payload:
              event.payload,
          }),
        ),
      },
      null,
      2,
    ),
  )

  const types =
    events.map(
      event =>
        event.type,
    )

  if (
    !types.includes(
      'task.started',
    )
  ) {
    throw new Error(
      'Missing task.started event',
    )
  }

  if (
    !types.includes(
      'agent.started',
    )
  ) {
    throw new Error(
      'Missing agent.started event',
    )
  }

  if (
    !types.includes(
      'verification.started',
    )
  ) {
    throw new Error(
      'Missing verification.started event',
    )
  }

  if (
    !types.includes(
      'review.started',
    )
  ) {
    throw new Error(
      'Missing review.started event',
    )
  }

  if (
    !types.includes(
      'task.completed',
    )
  ) {
    throw new Error(
      'Missing task.completed event',
    )
  }

  if (
    result.status !==
    'completed'
  ) {
    throw new Error(
      `Expected completed result, got ${result.status}`,
    )
  }

  console.log(
    'SERVICE EVENT TEST: PASS',
  )

  // The service is disposed by the exit path below, so the process ends on
  // its own with the skill filesystem's watchers closed.
}

void main()
  .catch(
    (error: unknown) => {
      console.error(
        error,
      )

      process.exitCode =
        1
    },
  )
  .finally(async () => {
    // THE SERVICE MUST BE DISPOSED (2026-11-07).
    //
    // This test used to call `process.exit(0)` with the service's skill
    // filesystem watchers still open. A forced exit tears those handles
    // down mid-close, and libuv asserts on it: the process died with
    // 0xC0000409 instead of exiting 0, and whether it happened depended on
    // the machine's mood. Disposing closes the watchers properly.
    try {
      await activeService?.dispose()
    } catch {
      // Best effort: the proof has already been printed.
    }
    rmSync(
      stateHome,
      {
        recursive: true,
        force: true,
      },
    )
  })