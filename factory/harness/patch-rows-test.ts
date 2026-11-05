/**
 * Patch rows test — the result card's diff, proven on a REAL git repository.
 *
 * The rule this file defends: the transcript shows what git actually reported,
 * bounded, and never invents a change. A non-repository shows nothing; an
 * untracked file shows nothing (it is already named in `files:`); a patch over
 * the budget stops at the budget and says so instead of scrolling the answer
 * off the screen.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PATCH_BUDGETS, patchRows } from './patch-rows'

const ANSI = /\x1b\[[0-9;]*m/g
const strip = (s: string): string => s.replace(ANSI, '')

function git(cwd: string, ...args: string[]): void {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(done.status, 0, `git ${args.join(' ')} failed: ${done.stderr}`)
}

async function main(): Promise<void> {
  const available = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true })
  if (available.status !== 0) {
    console.log('PATCH ROWS TEST: SKIP (git is not installed)')
    return
  }
  const base = await mkdtemp(join(tmpdir(), 'wednesday-patch-'))
  try {
    const repo = join(base, 'repo')
    await mkdir(repo)
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')

    // 1. A clean tree has no patch to show — and must not print a header that
    //    claims "+0 -0" changes.
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'base')
    assert.deepEqual(patchRows(repo, ['a.txt']), { rows: [], truncated: false })

    // 2. One modified file: one header, git's own +/- rows, nothing else.
    await writeFile(join(repo, 'a.txt'), 'one\nTWO\nthree\n', 'utf8')
    const one = patchRows(repo, ['a.txt'])
    const text = one.rows.map(row => strip(row.text))
    assert.equal(one.truncated, false)
    assert.match(text[0]!, /^@@ a\.txt vs HEAD · \+1 -1$/, 'the header states the file and the counts')
    assert.ok(text.includes('-two'), 'a removed line keeps git\'s prefix')
    assert.ok(text.includes('+TWO'), 'an added line keeps git\'s prefix')
    assert.ok(!text.some(row => row.startsWith('+++')), 'no +++ header leaks into the transcript')

    // 3. Two files: each one gets its own rule, or the rows below are anonymous.
    await writeFile(join(repo, 'b.txt'), 'alpha\n', 'utf8')
    git(repo, 'add', 'b.txt')
    git(repo, 'commit', '-qm', 'add b')
    await writeFile(join(repo, 'b.txt'), 'alpha\nbeta\n', 'utf8')
    const two = patchRows(repo, ['a.txt', 'b.txt']).rows.map(row => strip(row.text))
    assert.match(two[0]!, /^@@ 2 files vs HEAD · \+2 -1$/)
    assert.ok(two.includes('@@ a.txt'), 'the first file is named')
    assert.ok(two.includes('@@ b.txt'), 'the second file is named')

    // 4. The budget is a hard stop: a 40-line rewrite may not own the frame.
    await writeFile(join(repo, 'a.txt'), Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n', 'utf8')
    const bounded = patchRows(repo, ['a.txt'], 5)
    assert.equal(bounded.truncated, true, 'a cut patch reports itself')
    assert.equal(bounded.rows.length, 6, 'header + exactly the budget')

    // 5. An untracked file has no patch: named in `files:`, never guessed at.
    await writeFile(join(repo, 'fresh.txt'), 'never committed\n', 'utf8')
    assert.deepEqual(patchRows(repo, ['fresh.txt']), { rows: [], truncated: false })

    // 6. Outside a repository, and with no files, nothing is emitted.
    const bare = join(base, 'bare')
    await mkdir(bare)
    await writeFile(join(bare, 'x.txt'), 'x\n', 'utf8')
    assert.deepEqual(patchRows(bare, ['x.txt']), { rows: [], truncated: false })
    assert.deepEqual(patchRows(repo, []), { rows: [], truncated: false })

    // 7. The density table is the whole policy: quiet shows no patch at all,
    //    verbose reads further than the default, and neither is a guess.
    assert.deepEqual(PATCH_BUDGETS, { quiet: 0, normal: 14, verbose: 40 })

    console.log('PATCH ROWS TEST: PASS (clean/untracked/non-repo silent, one call, budgeted)')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
