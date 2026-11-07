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

// The cordis Context is held here so the exit path can dispose it (see the
// bottom of this file).
let activeContext: Context | undefined

async function main(): Promise<void> {
  const ctx = new Context()
  activeContext = ctx

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

  // The context is disposed by the exit path below, so the process ends on
  // its own with the skill filesystem's watchers closed.
}

void main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    // THE CONTEXT MUST BE DISPOSED (2026-11-07).
    //
    // This test used to call `process.exit(0)` with the skill filesystem's
    // watchers still open. A forced exit tears those handles down
    // mid-close, and libuv asserts on it: the process died with
    // 0xC0000409 instead of exiting 0, and whether it happened depended on
    // the machine's mood. Disposing the fiber closes the watchers properly.
    try {
      await activeContext?.fiber.dispose()
    } catch {
      // Best effort: the proof has already been printed.
    }
  })