import { join } from 'node:path'
import { DSH_ROOT, DSH_AGENTS_HOME, INSTALL_ROOT } from '../paths'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'

import {
  DshSkillAdapter,
  KnowledgeBuilder,
} from './index'

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