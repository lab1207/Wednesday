/**
 * Offline test for the diff DECISIONS: accept stages, reject puts back.
 * Uses a real temp git repository - no network, no model, no spend.
 *
 * The gap this closes (2026-11-05): `/review` showed what changed and
 * stopped there. The operator had to leave the harness and run git by
 * hand, so a review was a screenshot instead of a decision.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acceptFiles, rejectFiles, isTracked } from './diff-decisions'
import { recordLastRun, lastRun, clearLastRun } from './last-run'

function git(workspace: string, args: string[]): string {
  return execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim()
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'wednesday-diff-'))
  try {
    // A tiny repository with one tracked file.
    git(root, ['init'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    // No line-ending rewriting: the test is about the DECISION, not about
    // what Windows does to a checkout.
    git(root, ['config', 'core.autocrlf', 'false'])
    writeFileSync(join(root, 'tracked.txt'), 'original\n', 'utf8')
    git(root, ['add', 'tracked.txt'])
    git(root, ['commit', '-m', 'first'])

    // 1. The tracked file is tracked, and a new one is not.
    assert.equal(isTracked(root, 'tracked.txt'), true)
    assert.equal(isTracked(root, 'created.txt'), false)

    // 2. ACCEPT stages the change without committing it.
    writeFileSync(join(root, 'tracked.txt'), 'changed\n', 'utf8')
    writeFileSync(join(root, 'created.txt'), 'new file\n', 'utf8')
    const accepted = acceptFiles(root, ['tracked.txt', 'created.txt'])
    assert.equal(accepted.ok, true, accepted.lines.join(' | '))
    assert.ok(accepted.lines.some(line => /accepted: tracked\.txt/.test(line)))
    assert.ok(
      accepted.lines.some(line => /never commits on its own/.test(line)),
      'the receipt says the factory does not commit',
    )
    const staged = git(root, ['diff', '--cached', '--name-only'])
    assert.ok(staged.includes('tracked.txt'), 'the change is staged')
    assert.ok(staged.includes('created.txt'), 'the new file is staged')
    assert.equal(
      git(root, ['log', '--oneline']).split('\n').length,
      1,
      'accepting did not create a commit',
    )

    // 3. REJECT puts a tracked file back and removes a file the run created.
    const rejected = rejectFiles(root, ['tracked.txt', 'created.txt'])
    assert.equal(rejected.ok, true, rejected.lines.join(' | '))
    assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8').trim(), 'original', 'the tracked file is back')
    assert.equal(existsSync(join(root, 'created.txt')), false, 'the created file is gone')
    assert.ok(
      rejected.lines.some(line => /the run created it/.test(line)),
      'the receipt says why the file was removed',
    )

    // 4. An empty decision is refused, not a silent no-op.
    const empty = acceptFiles(root, [])
    assert.equal(empty.ok, false)
    assert.ok(/nothing to accept/.test(empty.lines.join(' ')))

    // 5. A path OUTSIDE the workspace is refused, not deleted.
    const outside = join(root, '..', `wednesday-outside-${Date.now()}.txt`)
    writeFileSync(outside, 'do not delete\n', 'utf8')
    try {
      const escaped = rejectFiles(root, [outside])
      assert.equal(escaped.ok, false, 'a path outside the workspace is refused')
      assert.ok(existsSync(outside), 'the outside file still exists')
      assert.ok(escaped.lines.some(line => /outside the workspace/.test(line)))
    } finally {
      rmSync(outside, { force: true })
    }

    // 6. The last run's footprint: what the run touched, in this workspace.
    clearLastRun()
    assert.equal(lastRun(), null)
    recordLastRun(root, ['tracked.txt'])
    const remembered = lastRun()
    assert.ok(remembered)
    assert.equal(remembered!.workspace, root)
    assert.deepEqual(remembered!.filesChanged, ['tracked.txt'])
    assert.ok(remembered!.at > 0)

    // 7. A run that changed nothing still records WHICH run it was.
    recordLastRun(root, [])
    assert.deepEqual(lastRun()!.filesChanged, [])

    console.log('diff-decisions: PASS')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
