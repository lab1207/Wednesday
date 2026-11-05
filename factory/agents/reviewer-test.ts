import { join } from 'node:path'
import { INSTALL_ROOT } from '../paths'
import {
  OpenRouterProvider,
  RegistryModelRouter,
} from '../model-router'

import {
  ReviewRunner,
} from './role-runners'

import {
  AgentRegistry,
} from './registry'

import type {
  AgentContext,
  AgentOutput,
} from './types'

async function main(): Promise<void> {
  const router = new RegistryModelRouter()
  router.register(new OpenRouterProvider())

  const registry = new AgentRegistry()
  const reviewer = registry.get('reviewer')

  const previousOutputs: AgentOutput[] = [
    {
      role: 'architect',
      summary: 'Architecture completed.',
      findings: [
        'Three-file Python calculator design.',
      ],
      recommendations: [
        'Use pytest.',
      ],
      blockingIssues: [],
    },
    {
      role: 'planner',
      summary: 'Implementation plan completed.',
      findings: [
        'Create calculator.py.',
        'Create test_calculator.py.',
        'Create README.md.',
      ],
      recommendations: [
        'Run pytest after implementation.',
      ],
      blockingIssues: [],
    },
    {
      role: 'coder',
      summary: 'Implementation completed.',
      findings: [
        'calculator.py created.',
        'test_calculator.py created.',
        'README.md created.',
      ],
      recommendations: [
        'Verification evidence is passing.',
      ],
      blockingIssues: [],
    },
    {
      role: 'tester',
      summary: 'Tester verification passed.',
      findings: [
        'PASS: pytest',
        '17 tests passed.',
      ],
      recommendations: [
        'Pass evidence to reviewer.',
      ],
      blockingIssues: [],
    },
  ]

  const context: AgentContext = {
    task: {
      id: 'review-test-001',
      workspace:
        join(INSTALL_ROOT, 'dsh-test-workspace'),
      objective:
        'Build a small Python calculator project.',
      role: 'backend',
      stack: 'python',
      constraints: [
        'Use pytest.',
        'Keep the implementation simple.',
      ],
      acceptanceCriteria: [
        'calculator.py exists',
        'test_calculator.py exists',
        'README.md exists',
        'pytest passes',
      ],
      modelRequirements: {
        capability: 'reasoning',
      },
    },
    workspace:
      join(INSTALL_ROOT, 'dsh-test-workspace'),
    previousOutputs,
  }

  const runner = new ReviewRunner(router)

  const result = await runner.run(
    reviewer,
    context,
  )

  console.log(JSON.stringify(result, null, 2))
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})