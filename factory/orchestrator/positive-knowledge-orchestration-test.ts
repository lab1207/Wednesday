import {
  DefaultRoleRunnerDispatcher,
  FactoryOrchestrator,
} from './orchestrator'

import {
  ReadOnlyModelRunner,
} from '../agents/role-runners'

import {
  OpenRouterProvider,
  RegistryModelRouter,
} from '../model-router'

import { join } from 'node:path'
import { DSH_ROOT, DSH_AGENTS_HOME, INSTALL_ROOT } from '../paths'
import { AgentRegistry } from '../agents'
import type {
  AgentContext,
  AgentOutput,
  AgentRole,
} from '../agents/types'

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'

import {
  DshSkillAdapter,
  KnowledgeBuilder,
} from '../knowledge'

class RecordingRunner {
  private readonly delegate: ReadOnlyModelRunner

  public contexts: AgentContext[] = []

  constructor(
    router: RegistryModelRouter,
  ) {
    this.delegate = new ReadOnlyModelRunner(router)
  }

  async run(
    role: AgentRole,
    context: AgentContext,
  ): Promise<AgentOutput> {
    this.contexts.push(context)

    return this.delegate.run(
      role,
      context,
    )
  }
}

async function main(): Promise<void> {
  // ------------------------------------------------------------
  // Model router
  // ------------------------------------------------------------

  const router = new RegistryModelRouter()

  router.register(
    new OpenRouterProvider(),
  )

  // ------------------------------------------------------------
  // DSH skill environment
  // ------------------------------------------------------------

  const ctx = new Context()

  await ctx.plugin(SkillRegistry)

  await ctx.plugin(
    SkillFileSystem,
    {
      dshHome:
        DSH_ROOT,
      agentsHome:
        DSH_AGENTS_HOME,
    },
  )

  const knowledgeBuilder =
    new KnowledgeBuilder(
      new DshSkillAdapter(ctx),
    )

  // ------------------------------------------------------------
  // Real analysis runner
  // ------------------------------------------------------------

  const recordingRunner =
    new RecordingRunner(router)

  // ------------------------------------------------------------
  // Only Architect + Planner are provided.
  // This prevents coder/tester/reviewer from running.
  // ------------------------------------------------------------

  const dispatcher =
    new DefaultRoleRunnerDispatcher(
      new Map([
        [
          'architect',
          recordingRunner,
        ],
        [
          'planner',
          recordingRunner,
        ],
      ]),
    )

  // ------------------------------------------------------------
  // Positive knowledge task
  // ------------------------------------------------------------

  const task = {
    id:
      'positive-knowledge-test-001',

    workspace:
      join(INSTALL_ROOT, 'dsh-test-workspace'),

    objective:
      'Review a DeepSeek Harness pull request for correctness, security, lifecycle issues, and regressions.',

    role:
      'backend',

    stack:
      'typescript',

    constraints: [],

    acceptanceCriteria: [
      'Architect and planner receive relevant review knowledge.',
    ],

    modelRequirements: {
      capability:
        'reasoning' as const,
    },
  }

  // ------------------------------------------------------------
  // Knowledge-aware orchestrator
  // ------------------------------------------------------------

  const orchestrator =
    new FactoryOrchestrator(
      new AgentRegistry(),
      dispatcher,
      {},
      knowledgeBuilder,
    )

  let result

  try {
    result =
      await orchestrator.run(task)
  } catch (error) {
    // The dispatcher intentionally has no coder,
    // tester, or reviewer. The expected evidence is
    // already captured in the recording runner.
    result = {
      status: 'partial',
      error:
        error instanceof Error
          ? error.message
          : String(error),
    }
  }

  console.log(
    JSON.stringify(
      {
        capturedContexts:
          recordingRunner.contexts.map(
            context => ({
              role:
                context.task.role,

              knowledgeSkills:
                context.knowledge?.skills
                  .map(skill => skill.name)
                  ?? [],

              promptContainsKnowledge:
                context.knowledge?.rendered
                  ? context.knowledge.rendered.length > 0
                  : false,

              renderedPreview:
                context.knowledge?.rendered
                  ?.slice(0, 500)
                  ?? '',
            }),
          ),

        result,
      },
      null,
      2,
    ),
  )

  // One-shot boundary (bridge.ts precedent): the cordis Context outlives the
  // probe — exit explicitly so this stays an exit-0 offline proof.
  process.exit(0)
}

void main().catch(
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  },
)