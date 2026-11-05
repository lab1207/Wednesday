import { join } from 'node:path'
import { DSH_ROOT, DSH_AGENTS_HOME, INSTALL_ROOT } from '../paths'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'

import {
  DshSkillAdapter,
  SkillSelector,
} from './index'

async function main(): Promise<void> {
  const ctx = new Context()

  await ctx.plugin(SkillRegistry)

  await ctx.plugin(SkillFileSystem, {
    dshHome: DSH_ROOT,
    agentsHome: DSH_AGENTS_HOME,
  })

  const adapter = new DshSkillAdapter(ctx)
  const selector = new SkillSelector()

  const skills = await adapter.list(
    join(INSTALL_ROOT, 'dsh-test-workspace'),
  )

  const selected = selector.select(
    skills,
    {
      objective:
  'Review a DeepSeek Harness pull request for correctness, security, lifecycle issues, and regressions.',
role: 'reviewer',
stack: 'typescript',
maxSkills: 5,
    },
  )

  console.log(JSON.stringify(
    selected.map(entry => ({
      name: entry.skill.name,
      score: entry.score,
      reasons: entry.reasons,
    })),
    null,
    2,
  ))

  // One-shot boundary (bridge.ts precedent): the cordis Context outlives the
  // probe — exit explicitly so this stays an exit-0 discovery proof.
  process.exit(0)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})