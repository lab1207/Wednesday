import {
  DefaultRoleRunnerDispatcher,
  FactoryOrchestrator,
} from './orchestrator'

import {
  ReadOnlyModelRunner,
  CodingRunner,
  TestingRunner,
  ReviewRunner,
} from '../agents/role-runners'

import {
  OpenRouterProvider,
  RegistryModelRouter,
} from '../model-router'

import { join } from 'node:path'
import { DSH_ROOT, DSH_AGENTS_HOME, INSTALL_ROOT } from '../paths'
import { AgentRegistry } from '../agents'

import { FactoryExecutor } from '../executor'
import { VerificationEngine } from '../verification'

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'

import {
  DshSkillAdapter,
  KnowledgeBuilder,
} from '../knowledge'

async function main(): Promise<void> {
  // ------------------------------------------------------------
  // DSH skill / ECC knowledge environment
  // ------------------------------------------------------------

  const ctx = new Context()

  await ctx.plugin(SkillRegistry)

  await ctx.plugin(SkillFileSystem, {
    dshHome: DSH_ROOT,
    agentsHome: DSH_AGENTS_HOME,
  })

  // THE CONTEXT MUST BE DISPOSED (2026-11-06).
  //
  // This test used to leave the cordis context running, so the process
  // NEVER EXITED: the run finished (or failed) and the event loop stayed
  // alive forever. A test suite that hangs is worse than one that fails,
  // because a sweep cannot report a red it never reached.
  //
  // `ctx.fiber.dispose()` unloads the plugins and releases the handles, so
  // the process can exit the moment the work is done.
  try {
    await runOrchestration(ctx)
  } finally {
    await ctx.fiber.dispose()
  }
}

async function runOrchestration(ctx: Context): Promise<void> {
  // ------------------------------------------------------------
  // Model router
  // ------------------------------------------------------------

  const router = new RegistryModelRouter()
  router.register(new OpenRouterProvider())

  const knowledgeBuilder = new KnowledgeBuilder(
    new DshSkillAdapter(ctx),
  )

  // ------------------------------------------------------------
  // Role runners
  // ------------------------------------------------------------

  const readOnlyRunner = new ReadOnlyModelRunner(
    router,
  )

  const codingRunner = new CodingRunner(
    new FactoryExecutor(),
  )

  const testingRunner = new TestingRunner(
    new VerificationEngine(),
  )

  const reviewRunner = new ReviewRunner(
    router,
  )

  // ------------------------------------------------------------
  // Dispatcher
  // ------------------------------------------------------------

  const dispatcher = new DefaultRoleRunnerDispatcher(
    new Map([
      ['architect', readOnlyRunner],
      ['planner', readOnlyRunner],
      ['coder', codingRunner],
      ['tester', testingRunner],
      ['reviewer', reviewRunner],
    ]),
  )

  // ------------------------------------------------------------
  // Task
  // ------------------------------------------------------------

  const task = {
    id: 'full-orchestration-test-001',

    workspace:
      join(INSTALL_ROOT, 'dsh-test-workspace'),

    objective:
      'Build a small Python calculator project with implementation, tests, and documentation.',

    role: 'backend',

    stack: 'python',

    constraints: [
      'Use pytest.',
      'Keep the implementation simple.',
      'Do not add a CLI.',
      'Do not add unnecessary dependencies.',
    ],

    acceptanceCriteria: [
      'calculator.py exists',
      'test_calculator.py exists',
      'README.md exists',
      'pytest passes',
    ],

    modelRequirements: {
      capability: 'coding' as const,
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

  // ------------------------------------------------------------
  // Knowledge-aware orchestrator
  // ------------------------------------------------------------

  const orchestrator = new FactoryOrchestrator(
    new AgentRegistry(),
    dispatcher,
    {},
    knowledgeBuilder,
  )

  const result = await orchestrator.run(task)

  console.log(
    JSON.stringify(
      result,
      null,
      2,
    ),
  )
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})