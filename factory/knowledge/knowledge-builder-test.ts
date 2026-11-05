import { join } from 'node:path'
import { DSH_ROOT, DSH_AGENTS_HOME, INSTALL_ROOT } from '../paths'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'

import {
  DshSkillAdapter,
  KnowledgeBuilder,
} from './index'

async function main(): Promise<void> {
  const ctx = new Context()

  await ctx.plugin(SkillRegistry)

  await ctx.plugin(SkillFileSystem, {
    dshHome: DSH_ROOT,
    agentsHome: DSH_AGENTS_HOME,
  })

  const builder = new KnowledgeBuilder(
    new DshSkillAdapter(ctx),
  )

  const knowledge = await builder.build({
    objective:
      'Review a DeepSeek Harness pull request for correctness, security, lifecycle issues, and regressions.',
    role: 'reviewer',
    stack: 'typescript',
    workspace:
      join(INSTALL_ROOT, 'dsh-test-workspace'),
    maxSkills: 3,
  })

  console.log(JSON.stringify({
    selectedSkills: knowledge.skills.map(skill => ({
      name: skill.name,
      contentLength: skill.content.length,
    })),
    renderedPreview:
      knowledge.rendered.slice(0, 1200),
  }, null, 2))

  // One-shot boundary (bridge.ts precedent): the cordis Context outlives the
  // probe — exit explicitly so this stays an exit-0 discovery proof.
  process.exit(0)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})