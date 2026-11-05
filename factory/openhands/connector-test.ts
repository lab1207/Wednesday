/**
 * Repository-profile memo — the pause nobody could explain.
 *
 * The CLI asks for a repository profile before every request. `analyzeRepository`
 * walks the whole tree, so a second request in the same session paid for the
 * same walk again: about a second of blocked event loop between "Enter" and the
 * confirm card, which is what made the gate feel late and the screen feel dead.
 *
 * Identity is the assertion, not a timer: a memoised profile is the SAME object,
 * so `a === b` proves the second call did not walk again, and a fresh object
 * after `clearRepositoryProfileCache()` proves the escape hatch works.
 *
 *   npx tsx factory/openhands/connector-test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { analyzeRepository, analyzeRepositoryCached, clearRepositoryProfileCache } from './connector.js'

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'connector-cache-'))
  const workspace = join(root, 'project')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { undici: '^8' } }))
  writeFileSync(join(workspace, 'src', 'index.ts'), "import { join } from 'node:path'\nexport const x = join('a', 'b')\n")

  const first = await analyzeRepositoryCached(workspace)
  const second = await analyzeRepositoryCached(workspace)
  assert.strictEqual(first, second, 'the second request reuses the profile instead of re-walking')
  assert.ok(first.languages.includes('TypeScript'), 'the profile still describes the workspace')
  assert.ok(first.toConstraints().length > 0, 'and it still produces constraints for the plan')

  // Concurrent callers share ONE walk rather than starting their own.
  clearRepositoryProfileCache()
  const [a, b] = await Promise.all([analyzeRepositoryCached(workspace), analyzeRepositoryCached(workspace)])
  assert.strictEqual(a, b, 'concurrent callers share the in-flight walk')

  // Different paths are different entries: switching --workspace must not be
  // served the previous workspace's languages.
  const other = join(root, 'other')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'main.py'), 'print("hi")\n')
  const otherProfile = await analyzeRepositoryCached(other)
  assert.notStrictEqual(otherProfile, first, 'a different workspace gets its own profile')
  assert.ok(otherProfile.languages.includes('Python'), 'and it is the right one')

  // The escape hatch: after clearing, the walk happens again.
  clearRepositoryProfileCache()
  const fresh = await analyzeRepositoryCached(workspace)
  assert.notStrictEqual(fresh, first, 'clearRepositoryProfileCache forces a fresh walk')
  assert.deepStrictEqual(fresh.languages, first.languages, 'and the fresh walk agrees')

  // A missing workspace is fail-open by design (`analyzeRepository` swallows the
  // walk error and reports `exists: false`), and that empty profile is still
  // memoised — re-walking a directory that does not exist buys nothing.
  clearRepositoryProfileCache()
  const missing = join(root, 'does-not-exist')
  const gone = await analyzeRepositoryCached(missing)
  assert.equal(gone.exists, false, 'a missing workspace reports exists: false instead of throwing')
  assert.strictEqual(await analyzeRepositoryCached(missing), gone, 'and that answer is cached too')

  // The uncached entry point is still the source of truth.
  const direct = await analyzeRepository(workspace)
  assert.deepStrictEqual(direct.languages, first.languages, 'analyzeRepository is unchanged by the memo')

  // AppData is never walked. The 2026-10-16 freeze: a bare request with no
  // --workspace defaults to the home directory, and the walk descended into
  // the profile's caches — the screen sat with a live spinner and a dead
  // keyboard for as long as that took. A project-shaped tree with an
  // AppData below it must not pick up anything from inside.
  const homeish = join(root, 'homeish')
  mkdirSync(join(homeish, 'src'), { recursive: true })
  mkdirSync(join(homeish, 'AppData', 'Local', 'Temp', 'pkg'), { recursive: true })
  writeFileSync(join(homeish, 'src', 'app.ts'), 'export const app = 1\n')
  writeFileSync(join(homeish, 'AppData', 'Local', 'Temp', 'pkg', 'cache.js'), 'module.exports = 1\n')
  clearRepositoryProfileCache()
  const homeProfile = await analyzeRepositoryCached(homeish)
  assert.ok(homeProfile.languages.includes('TypeScript'), 'the real source under the root is still profiled')
  assert.ok(!homeProfile.languages.includes('JavaScript'), 'nothing inside AppData is profiled')
  assert.equal(homeProfile.fileCount, 1, 'and no AppData file reaches the inventory')

  console.log('CONNECTOR TEST: PASS (profile memo: reuse, concurrency, isolation, escape hatch, fail-open, AppData never walked)')
}

void main().catch(error => {
  console.error(String(error))
  process.exitCode = 1
})
