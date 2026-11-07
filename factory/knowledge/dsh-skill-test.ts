import { join } from 'node:path'
import { DSH_ROOT, DSH_AGENTS_HOME, INSTALL_ROOT } from '../paths'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { DshSkillAdapter } from './dsh-skill-adapter'

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