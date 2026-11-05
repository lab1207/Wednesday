import { join } from 'node:path'
import { INSTALL_ROOT } from '../paths'
import { FactoryExecutor } from './index'
import type { EngineeringTask } from '../contracts'

const task: EngineeringTask = {
  id: 'executor-test-001',
  workspace: join(INSTALL_ROOT, 'dsh-test-workspace'),
  objective:
    'Build a small Python calculator project with calculator.py, test_calculator.py, and README.md. The calculator must support add, subtract, multiply, and divide.',
  role: 'backend',
  stack: 'python',
  constraints: [
    'Use pytest for tests',
    'Keep the implementation simple',
    'Handle division by zero safely',
  ],
  acceptanceCriteria: [
    'calculator.py exists',
    'test_calculator.py exists',
    'README.md exists',
    'pytest passes',
  ],
acceptance: {
  requiredFiles: [
    'calculator.py',
    'test_calculator.py',
    'README.md',
  ],
},
  modelRequirements: {
    capability: 'coding',
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

async function main(): Promise<void> {
  const executor = new FactoryExecutor()
  const result = await executor.execute(task)

  console.log(JSON.stringify(result, null, 2))
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})