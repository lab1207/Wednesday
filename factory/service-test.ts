import { join } from 'node:path'
import { INSTALL_ROOT } from './paths'
import {
  createFactoryService,
} from './service'

import type {
  EngineeringTask,
} from './contracts'

async function main(): Promise<void> {
  const service =
    await createFactoryService()

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
}

void main().catch(
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  },
)