import { OpenRouterProvider, RegistryModelRouter } from '../model-router/index'
import type { EngineeringTask } from './index'
import { join } from 'node:path'
import { INSTALL_ROOT } from '../paths'

async function main(): Promise<void> {
  const task: EngineeringTask = {
    id: 'contract-test-001',
    workspace: join(INSTALL_ROOT, 'dsh-test-workspace'),
    objective: 'Build a Python CLI calculator',
    role: 'backend',
    stack: 'python',
    constraints: [
      'Use pytest',
      'Keep the implementation simple',
    ],
    acceptanceCriteria: [
      'Calculator supports add, subtract, multiply, divide',
      'All tests pass',
    ],
    modelRequirements: {
      capability: 'coding',
    },
  }

  const router = new RegistryModelRouter()
  router.register(new OpenRouterProvider())

  const route = await router.select(task.modelRequirements)

  console.log(JSON.stringify({
    task,
    selectedRoute: route,
  }, null, 2))
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})