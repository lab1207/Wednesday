import { join } from 'node:path'
import { INSTALL_ROOT } from '../paths'
import {
  createFactoryService,
} from '../service'

import type {
  EngineeringTask,
} from '../contracts'

async function main(): Promise<void> {
  process.env.FACTORY_EXECUTION_MODE =
    'deterministic'

  const service =
    await createFactoryService()

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

  // One-shot CLI boundary (bridge.ts precedent): the service holds a cordis
  // Context that keeps the event loop alive after PASS — exit explicitly.
  process.exit(0)
}

void main().catch(
  (error: unknown) => {
    console.error(
      error,
    )

    process.exitCode =
      1
  },
)