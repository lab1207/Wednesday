/**
 * A TEST'S OWN STATE HOME.
 *
 * WHY THIS EXISTS (2026-11-10):
 *
 * `factory/paths.ts` captures `STATE_HOME` when it is FIRST imported, so a
 * test that wants its own state must set the env var before anything pulls
 * that module in. A static `import` of this file, placed FIRST in the test,
 * does exactly that: ESM evaluates imports in source order, so this module
 * runs before `./harness.js` and before `../events/index.js`.
 *
 * (An assignment in the test's own body does NOT work: every static import
 * is evaluated before the body runs, so the module graph -- and with it
 * `paths.ts` -- would already have captured the operator's real state.)
 *
 * WHY IT MATTERS: the tests used to read the operator's LIVE
 * `~/.wednesday/state`. With a team selected on the machine, `/team` printed
 * that team's policy instead of saying there is no team, and the chat smoke
 * sent its question to a hosted model instead of the scripted local server.
 * Both failures had nothing to do with the code under test, and both looked
 * like real regressions.
 *
 * A test that reads the operator's real state is not a test.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.WEDNESDAY_STATE_HOME = join(
  mkdtempSync(join(tmpdir(), 'wednesday-state-')),
  '.wednesday',
  'state',
)

/** The state home this test owns. */
export const TEST_STATE_HOME =
  process.env.WEDNESDAY_STATE_HOME
