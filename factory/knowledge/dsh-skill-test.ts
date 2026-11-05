import { join } from 'node:path'
import { DSH_ROOT, DSH_AGENTS_HOME, INSTALL_ROOT } from '../paths'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { DshSkillAdapter } from './dsh-skill-adapter'

async function main(): Promise<void> {
  const ctx = new Context()

  await ctx.plugin(SkillRegistry)

  await ctx.plugin(SkillFileSystem, {
    dshHome: DSH_ROOT,
    agentsHome: DSH_AGENTS_HOME,
  })

  const adapter = new DshSkillAdapter(ctx)

  const skills = await adapter.list(
    join(INSTALL_ROOT, 'dsh-test-workspace'),
  )

  const selected = skills.find(
    skill => skill.name === 'dsh-code-review',
  )

  if (selected === undefined) {
    throw new Error('dsh-code-review was not discovered')
  }

  const loaded = await adapter.load(
    selected.name,
    join(INSTALL_ROOT, 'dsh-test-workspace'),
  )

  if (loaded === undefined) {
    throw new Error('dsh-code-review could not be loaded')
  }

  console.log(JSON.stringify({
    discovered: {
      name: selected.name,
      source: selected.source,
      provider: selected.provider,
    },
    loaded: {
      name: loaded.name,
      source: loaded.source,
      provider: loaded.provider,
      contentPreview: loaded.content.slice(0, 500),
      contentLength: loaded.content.length,
    },
  }, null, 2))

  // One-shot boundary (bridge.ts precedent): the cordis Context outlives the
  // probe — exit explicitly so discovery/load stays an exit-0 proof.
  process.exit(0)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})