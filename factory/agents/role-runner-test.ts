import { join } from 'node:path'
import assert from 'node:assert/strict'
import { INSTALL_ROOT } from '../paths'
import {
  AnalysisRunner,
  ReviewRunner,
  TestingRunner,
} from './index'
import { AgentRegistry } from './registry'
import { RegistryModelRouter } from '../model-router'
import { DeterministicProvider } from '../model-router/providers/deterministic'
import type { AgentContext } from './types'

async function main(): Promise<void> {
  const registry = new AgentRegistry()

  // Offline review: the deterministic provider answers the reviewer prompt
  // with valid pass JSON, so no live model is needed. Production always
  // injects a real router (service.ts/run.ts); the bare constructor call
  // this replaces was the historical failure (router undefined).
  const router = new RegistryModelRouter()
  router.register(new DeterministicProvider())

  const context: AgentContext = {
    task: {
      id: 'role-runner-test-001',
      workspace: join(INSTALL_ROOT, 'dsh-test-workspace'),
      objective: 'Verify role-specific runners.',
      role: 'backend',
      stack: 'python',
      constraints: [],
      acceptanceCriteria: [
        'Testing runner can execute verification.',
      ],
      verification: {
        setupCommands: [],
        testCommands: [
          '.\\.venv\\Scripts\\python.exe -m pytest -q',
        ],
      },
    },
    workspace: join(INSTALL_ROOT, 'dsh-test-workspace'),
    previousOutputs: [],
  }

  const architect = registry.get('architect')
  const planner = registry.get('planner')
  const tester = registry.get('tester')
  const reviewer = registry.get('reviewer')

  const analysisRunner = new AnalysisRunner()
  const testingRunner = new TestingRunner()
  const reviewRunner = new ReviewRunner(router)

  const architectResult = await analysisRunner.run(architect, context)
  const plannerResult = await analysisRunner.run(planner, {
    ...context,
    previousOutputs: [architectResult],
  })

  const testerContext: AgentContext = {
    ...context,
    previousOutputs: [
      architectResult,
      plannerResult,
    ],
  }

  const testerResult = await testingRunner.run(tester, testerContext)

  const reviewerResult = await reviewRunner.run(reviewer, {
    ...testerContext,
    previousOutputs: [
      architectResult,
      plannerResult,
      testerResult,
    ],
  })

  console.log(JSON.stringify({
    architect: architectResult,
    planner: plannerResult,
    tester: testerResult,
    reviewer: reviewerResult,
  }, null, 2))

  assert.equal(reviewerResult.role, 'reviewer')
  assert.deepEqual(reviewerResult.blockingIssues, [])
  console.log('ROLE RUNNER TEST: PASS (analysis + verification + deterministic review)')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})