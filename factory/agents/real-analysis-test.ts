import { join } from 'node:path'
import { DSH_ROOT, DSH_AGENTS_HOME, INSTALL_ROOT } from '../paths'
import { AgentRegistry } from './index'
import { ReadOnlyModelRunner } from './role-runners'
import {
  OpenRouterProvider,
  RegistryModelRouter,
} from '../model-router'
import type { AgentContext } from './types'

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'

import {
  DshSkillAdapter,
  KnowledgeBuilder,
} from '../knowledge'

async function main(): Promise<void> {
  const registry = new AgentRegistry()

  // Create a small dsh skill environment for this test.
  const ctx = new Context()

  await ctx.plugin(SkillRegistry)

  await ctx.plugin(SkillFileSystem, {
    dshHome: DSH_ROOT,
    agentsHome: DSH_AGENTS_HOME,
  })

  const knowledgeBuilder = new KnowledgeBuilder(
    new DshSkillAdapter(ctx),
  )

  // Model router.
  const router = new RegistryModelRouter()
  router.register(new OpenRouterProvider())

  // Read-only model runner for Architect + Planner.
  const runner = new ReadOnlyModelRunner(router)

  const task = {
    id: 'real-analysis-001',
    workspace: join(INSTALL_ROOT, 'dsh-test-workspace'),

    objective:
      'Design a small Python calculator project with tests and documentation.',

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
      capability: 'reasoning' as const,
    },
  }

  const architect = registry.get('architect')
  const planner = registry.get('planner')

  // ------------------------------------------------------------
  // Architect knowledge
  // ------------------------------------------------------------

  const architectKnowledge =
    await knowledgeBuilder.build({
      objective: task.objective,
      role: 'architect',
      stack: task.stack,
      workspace: task.workspace,
      maxSkills: 3,
    })

  const architectContext: AgentContext = {
    task,
    workspace: task.workspace,
    previousOutputs: [],
    knowledge: architectKnowledge,
  }

  const architectResult = await runner.run(
    architect,
    architectContext,
  )

  // ------------------------------------------------------------
  // Planner knowledge
  // ------------------------------------------------------------

  const plannerKnowledge =
    await knowledgeBuilder.build({
      objective: task.objective,
      role: 'planner',
      stack: task.stack,
      workspace: task.workspace,
      maxSkills: 3,
    })

  const plannerContext: AgentContext = {
    task,
    workspace: task.workspace,
    previousOutputs: [
      architectResult,
    ],
    knowledge: plannerKnowledge,
  }

  const plannerResult = await runner.run(
    planner,
    plannerContext,
  )

  console.log(
    JSON.stringify(
      {
        architectKnowledge: {
          skills: architectKnowledge.skills.map(
            skill => skill.name,
          ),
        },

        plannerKnowledge: {
          skills: plannerKnowledge.skills.map(
            skill => skill.name,
          ),
        },

        architect: architectResult,

        planner: plannerResult,
      },
      null,
      2,
    ),
  )
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})