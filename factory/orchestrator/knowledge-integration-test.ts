import { join } from 'node:path'
import { DSH_ROOT, DSH_AGENTS_HOME, INSTALL_ROOT } from '../paths'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'

import {
  DshSkillAdapter,
  KnowledgeBuilder,
} from '../knowledge'

import {
  AgentRegistry,
} from '../agents'

import {
  buildKnowledgeAwarePrompt,
} from '../agents/role-runners'

async function main(): Promise<void> {
  const ctx = new Context()

  await ctx.plugin(SkillRegistry)

  await ctx.plugin(SkillFileSystem, {
    dshHome: DSH_ROOT,
    agentsHome: DSH_AGENTS_HOME,
  })

  const knowledgeBuilder = new KnowledgeBuilder(
    new DshSkillAdapter(ctx),
  )

  const knowledge = await knowledgeBuilder.build({
    objective:
      'Review a DeepSeek Harness pull request for correctness, security, lifecycle issues, and regressions.',
    role: 'reviewer',
    stack: 'typescript',
    workspace:
      join(INSTALL_ROOT, 'dsh-test-workspace'),
    maxSkills: 3,
  })

  const registry = new AgentRegistry()
const reviewer = registry.get('reviewer')

  const context = {
    task: {
      id: 'knowledge-integration-test-001',
      workspace:
        join(INSTALL_ROOT, 'dsh-test-workspace'),
      objective:
        'Review a DeepSeek Harness pull request for correctness, security, lifecycle issues, and regressions.',
      role: 'reviewer',
      stack: 'typescript',
      constraints: [],
      acceptanceCriteria: [],
    },
    workspace:
      join(INSTALL_ROOT, 'dsh-test-workspace'),
    previousOutputs: [],
    knowledge,
  }

  const prompt = buildKnowledgeAwarePrompt(
  reviewer,
  context,
)

  console.log(JSON.stringify({
    selectedSkills: knowledge.skills.map(skill => skill.name),
    promptContainsKnowledge:
      prompt.includes('dsh-code-review'),
    promptPreview: prompt.slice(0, 2500),
  }, null, 2))

  // One-shot boundary (bridge.ts precedent): the cordis Context outlives the
  // probe — exit explicitly so this stays an exit-0 offline proof.
  process.exit(0)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})