/**
 * A TEST'S OWN SKILLS HOME.
 *
 * WHY THIS EXISTS (2026-11-11):
 *
 * `factory/paths.ts` captures `SKILLS_HOME` when it is FIRST imported, so a
 * test that wants its own skills home must set the env var before anything
 * pulls that module in. A static `import` of this file, placed FIRST in the
 * test, does exactly that: ESM evaluates imports in source order, so this
 * module runs before `../paths.js` and before the adapters that read it.
 *
 * (An assignment in the test's own body does NOT work: every static import
 * is evaluated before the body runs, so the module graph -- and with it
 * `paths.ts` -- would already have captured the operator's real home.)
 *
 * WHY IT MATTERS: a test that installs a skill into the operator's real
 * `~/.wednesday/skills/` leaves it there, and the next run of the factory
 * would pick it up. A test that reads the operator's real home asserts on
 * whatever happens to be installed. Neither is a test.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.WEDNESDAY_SKILLS_HOME = join(
  mkdtempSync(join(tmpdir(), 'wednesday-skills-')),
  'skills',
)

/** The skills home this test owns. */
export const TEST_SKILLS_HOME = process.env.WEDNESDAY_SKILLS_HOME
