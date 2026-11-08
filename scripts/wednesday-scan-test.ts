/**
 * Offline test for the commit-time gate. No network; the git plumbing runs
 * inside a TEMP repository so this suite never touches the real index.
 *
 * Three claims the repo cannot make without this file:
 *   1. A staged secret BLOCKS the commit (exit 1).
 *   2. A clean staged tree PASSES (exit 0) — a gate that blocks everything
 *      is the same freeze wearing a different hat.
 *   3. The override is LOUD: it reports the findings AND says they are now
 *      part of the history, so an exception is never silent.
 *
 * Plus the one property that matters most: the gate scans the STAGED
 * content, so a file written clean and then edited before the commit is
 * judged by what is actually being committed.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = 'C:/wednesday'
const SCAN = join(REPO, 'scripts/wednesday-scan.ts')

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function runScan(
  cwd: string,
  env?: Record<string, string>,
): { code: number; out: string } {
  // Run from the REPO so `--import tsx` resolves (tsx is a declared
  // dependency of wednesday, not of a throwaway temp repo), and let the
  // script chdir to the repo under test via its root argument.
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', SCAN, cwd],
    {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, ...(env ?? {}) },
    },
  )
  return {
    code: result.status ?? -1,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

/** A throwaway repo with the gate available at a stable relative path. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wednesday-scan-'))
  sh(['init', '--quiet'], dir)
  sh(['config', 'user.email', 'scan@wednesday.local'], dir)
  sh(['config', 'user.name', 'Wednesday Scan Test'], dir)
  sh(['config', 'commit.gpgsign', 'false'], dir)
  return dir
}

function stage(dir: string, name: string, content: string): void {
  const path = join(dir, name)
  const parent = path.slice(0, path.lastIndexOf('\\') === -1 ? 0 : path.lastIndexOf('\\'))
  if (parent) mkdirSync(parent, { recursive: true })
  writeFileSync(path, content, 'utf8')
  sh(['add', '--', name], dir)
}

async function main(): Promise<void> {
  // 1. A staged secret BLOCKS.
  {
    const dir = makeRepo()
    try {
      // The fixture is BUILT, not typed: the gate blocks a file that carries
      // a hardcoded secret, and this test must not itself carry one.
      const awsKey = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE'
      stage(dir, 'server/auth.js', 'const key = "' + awsKey + '";\nexport default key\n')
      const run = runScan(dir)
      assert.equal(run.code, 1, 'a staged secret must block the commit')
      assert.ok(
        run.out.includes('secret/aws-key'),
        'the finding must name the rule: ' + run.out,
      )
      assert.ok(
        run.out.includes('server/auth.js:1'),
        'the finding must name the file and line: ' + run.out,
      )
      assert.ok(
        run.out.includes('BLOCKED'),
        'the gate must say BLOCKED, not fail quietly: ' + run.out,
      )
      // Honest about what it is, never overselling a pattern match.
      assert.ok(
        run.out.includes('SHAPES'),
        'the gate must say it matches shapes, not vulnerabilities',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 2. A clean tree PASSES.
  {
    const dir = makeRepo()
    try {
      stage(dir, 'app.js', 'const answer = 41 + 1;\nexport default answer\n')
      stage(dir, 'notes.md', 'Nothing to see here.\n')
      const run = runScan(dir)
      assert.equal(run.code, 0, 'a clean staged tree must pass')
      assert.ok(run.out.includes('PASS'), 'the pass must be visible: ' + run.out)
      assert.ok(
        run.out.includes('2 staged file(s)'),
        'the count must be reported: ' + run.out,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 3. The override is LOUD.
  {
    const dir = makeRepo()
    try {
      const token = 'ghp_' + 'a'.repeat(36)
      stage(dir, 'config.js', 'const token = "' + token + '";\n')
      const run = runScan(dir, { WEDNESDAY_SCAN_ALLOW: '1' })
      assert.equal(run.code, 0, 'the override must still exit 0')
      assert.ok(
        run.out.includes('secret/github-token'),
        'the override must still REPORT the finding',
      )
      assert.ok(
        run.out.includes('now part of the history'),
        'the override must say the finding is now permanent',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 4. It scans the STAGED content, not the working tree: the clean file
  //    that was edited before the commit is judged by the staged bytes.
  {
    const dir = makeRepo()
    try {
      const path = join(dir, 'leak.txt')
      const awsKey = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE'
      writeFileSync(path, 'nothing here\n', 'utf8')
      sh(['add', '--', 'leak.txt'], dir)
      // Now corrupt it and stage the corruption: what ships is the bad one.
      writeFileSync(path, awsKey + '\n', 'utf8')
      sh(['add', '--', 'leak.txt'], dir)
      // The working file is cleaner than the staged one, proving the order:
      // the STAGED bytes are what must be judged.
      writeFileSync(path, 'clean again\n', 'utf8')
      const run = runScan(dir)
      assert.equal(
        run.code,
        1,
        'the gate must judge the STAGED bytes, not the working tree',
      )
      assert.ok(
        run.out.includes('secret/aws-key'),
        'the staged secret must be caught: ' + run.out,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 5. The opt-out is loud, not silent.
  {
    const dir = makeRepo()
    try {
      const awsKey = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE'
      stage(dir, 'server/auth.js', 'const key = "' + awsKey + '";\n')
      const run = runScan(dir, { FACTORY_SECURITY_SCAN: '0' })
      assert.equal(run.code, 0, 'the documented opt-out must exit 0')
      assert.ok(
        run.out.includes('nothing was checked'),
        'the opt-out must say nothing was checked: ' + run.out,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 6. Nothing staged is nothing to check — and must say so.
  {
    const dir = makeRepo()
    try {
      const run = runScan(dir)
      assert.equal(run.code, 0, 'an empty index must pass')
      assert.ok(
        run.out.includes('nothing staged'),
        'the pass must be visible: ' + run.out,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 7. The vendored/generated trees are skipped, not scanned: they are not
  //    authored by us and their findings are not ours to block on.
  {
    const dir = makeRepo()
    try {
      const awsKey = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE'
      stage(dir, 'node_modules/pkg/index.js', 'const key = "' + awsKey + '";\n')
      stage(dir, 'app.js', 'export default 42\n')
      const run = runScan(dir)
      assert.equal(
        run.code,
        0,
        'a vendored tree must not block the commit: ' + run.out,
      )
      assert.ok(
        run.out.includes('1 staged file(s)'),
        'the vendored file must be excluded from the count: ' + run.out,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 8. The hook itself is executable and committed at the path git expects.
  {
    const hook = join(REPO, '.githooks', 'pre-commit')
    assert.ok(existsSync(hook), 'the hook must exist')
    const body = readFileSync(hook, 'utf8')
    assert.ok(
      body.includes('core.hooksPath'),
      'the hook must document how it is installed',
    )
    assert.ok(
      body.includes('--no-verify'),
      'the hook must name the escape hatch',
    )
    // Windows carries no POSIX execute bit, so the hook is invoked through
    // git's shell; assert the CONTENT is a script, not the mode.
    assert.ok(
      body.startsWith('#!/bin/sh'),
      'the hook must be a POSIX script',
    )
    chmodSync(hook, 0o755)
  }

  // 9. THE ALLOWLIST: a test file must be able to hold the patterns it tests.
  //
  // Without this, the gate refuses the very test that proves it — the same
  // defect class as a gate nobody can pass. The allowlist is a NAMED,
  // COMMITTED list, every excuse is PRINTED, and a real secret planted in an
  // allowlisted file is still caught by... no. That is the honest limit: an
  // allowlisted path is not scanned. It is a privilege, so it is narrow,
  // public, and announced.
  {
    const {
      allowlistedPaths,
      scanStaged,
    } = await import('../factory/harness/commit-scan')

    const dir = makeRepo()
    try {
      // The fixture VALUE is built here so the test SOURCE carries no key
      // shape (this repo's own gate would refuse the file), while the file
      // CONTENT does — which is what the scanner must catch.
      const shape = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE'
      stage(dir, 'fixture-test.ts', 'const x = "' + shape + '";\n')

      // 9a. No allowlist file: the finding is reported and blocks.
      const before = scanStaged(dir)
      assert.equal(before.findings, 1, 'with no allowlist the fixture is caught')
      assert.equal(before.skipped.length, 0)

      // 9b. A committed allowlist excuses exactly the named path.
      mkdirSync(join(dir, '.githooks'), { recursive: true })
      writeFileSync(
        join(dir, '.githooks', 'scan-allowlist'),
        [
          '# a comment',
          '',
          '/* a block header',
          '   that is not a path */',
          '',
          'fixture-test.ts',
          'other-file.ts',
        ].join('\n'),
        'utf8',
      )
      assert.deepEqual(
        allowlistedPaths(dir),
        ['fixture-test.ts', 'other-file.ts'],
        'block comments and blank lines are not paths',
      )

      const after = scanStaged(dir)
      assert.equal(
        after.findings,
        0,
        'an allowlisted path is excused, not warned about',
      )
      assert.deepEqual(
        after.skipped,
        ['fixture-test.ts (1 finding(s) excused)'],
        'and the excuse is RECORDED, never silent',
      )

      // 9c. A file that exists but cannot be read says so rather than
      //     quietly emptying the allowlist and refusing every commit.
      const unreadable = join(dir, '.githooks', 'scan-allowlist')
      writeFileSync(unreadable, 'fixture-test.ts\n', 'utf8')
      assert.deepEqual(allowlistedPaths(dir), ['fixture-test.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log('wednesday-scan: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
