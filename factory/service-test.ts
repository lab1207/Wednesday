import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  EngineeringTask,
} from './contracts'

/**
 * THE TEST MUST NOT WRITE INTO THE OPERATOR'S REAL STATE (2026-11-07).
 *
 * This suite used to run against the default state home, so its events
 * landed in the operator's own `~/.wednesday/state/events.jsonl` and its
 * task record in the operator's own task store. The state home is set
 * BEFORE the modules that read it are imported: `paths.ts` resolves the
 * paths at import time, so setting the variable later is a no-op.
 */
const stateHome =
  mkdtempSync(
    join(
      tmpdir(),
      'factory-service-test-',
    ),
  )

process.env.WEDNESDAY_STATE_HOME =
  stateHome
process.env.FACTORY_EVENTS_PATH =
  join(stateHome, 'events.jsonl')
process.env.HERMES_TASKS_PATH =
  join(stateHome, 'tasks.json')

const { INSTALL_ROOT } =
  await import('./paths')
const { createFactoryService } =
  await import('./service')

async function main(): Promise<void> {
  const service =
    await createFactoryService()

  // THE SERVICE MUST BE DISPOSED (2026-11-07).
  //
  // The service boots the DSH skill filesystem, which WATCHES every skill
  // root it discovers - about twenty-three open watchers. This test used to
  // finish its work and then hang forever with the event loop held open, so
  // a full sweep never reported: a hung suite is worse than a red one.
  try {
    const task: EngineeringTask = {
      id: 'factory-service-test-001',

      workspace:
        join(INSTALL_ROOT, 'dsh-test-workspace'),

      objective:
        'Build a small Python calculator.',

      role: 'backend',

      stack: 'python',

      constraints: [
        'Use pytest',
        'Keep the implementation simple',
      ],

      acceptanceCriteria: [
        'calculator.py exists',
        'test_calculator.py exists',
        'README.md exists',
        'pytest passes',
      ],

      modelRequirements: {
        capability: 'coding',
      },

      acceptance: {
        requiredFiles: [
          'calculator.py',
          'test_calculator.py',
          'README.md',
        ],
      },

      verification: {
        setupCommands: [
          'python -m venv .venv',
          '.\\.venv\\Scripts\\python.exe -m pip install pytest',
        ],

        testCommands: [
          '.\\.venv\\Scripts\\python.exe -m pytest -q',
        ],
      },
    }

    const result =
      await service.run(task)

    console.log(
      JSON.stringify(
        result,
        null,
        2,
      ),
    )
  } finally {
    await service.dispose()
    rmSync(
      stateHome,
      {
        recursive: true,
        force: true,
      },
    )
  }
}

void main().catch(
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  },
)