/**
 * The scan COMMAND, tested where the operator actually types it (2026-11-08,
 * B231).
 *
 * Two bugs were found by RUNNING this rather than asserting it, and both are
 * pinned here so they cannot come back:
 *
 *   1. `wednesday scan` was added to `factory/cli.ts` only — but the
 *      installed package's bin is the HARNESS (`bin/wednesday.js`), so the
 *      operator's own command fell through to the request parser and died
 *      with `Unknown option: --repo` while a task preview appeared. The
 *      harness now dispatches the command BEFORE startup health.
 *   2. The env-form escape hatch (`WEDNESDAY_SCAN_ALLOW=1`) was dropped when
 *      the logic was refactored into one shared module — which turned a
 *      documented escape hatch into a lie. The hook cannot add a flag to a
 *      `git commit`, so the env var is the ONLY form that works there.
 *
 * Offline by construction; the git plumbing runs in temp repositories.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hookScript, installHook, repoRoot, scanStaged } from './commit-scan'
import { parseScanArgs } from './scan-command'

const REPO = 'C:/wednesday'
const HARNESS_BIN = join(REPO, 'bin/wednesday.js')
const CLI = join(REPO, 'factory/cli.ts')

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scan-command-'))
  sh(['init', '--quiet'], dir)
  sh(['config', 'user.email', 't@wednesday.local'], dir)
  sh(['config', 'user.name', 'Scan Command Test'], dir)
  sh(['config', 'commit.gpgsign', 'false'], dir)
  return dir
}

function stage(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf8')
  sh(['add', '--', name], dir)
}

async function main(): Promise<void> {
  // 1. The escape hatch has TWO forms, and the env form is the one the hook
  //    can use: a hook cannot add a flag to a `git commit`.
  assert.equal(
    parseScanArgs([]).allow,
    false,
    'with neither form the gate blocks',
  )
  assert.equal(
    parseScanArgs(['--allow-findings']).allow,
    true,
    'the flag form allows',
  )

  const saved = process.env.WEDNESDAY_SCAN_ALLOW
  try {
    process.env.WEDNESDAY_SCAN_ALLOW = '1'
    assert.equal(
      parseScanArgs([]).allow,
      true,
      'the env form allows — a documented escape hatch must not become a lie',
    )
    process.env.WEDNESDAY_SCAN_ALLOW = '0'
    assert.equal(
      parseScanArgs([]).allow,
      false,
      'the env form with a non-1 value does not allow',
    )
  } finally {
    if (saved === undefined) delete process.env.WEDNESDAY_SCAN_ALLOW
    else process.env.WEDNESDAY_SCAN_ALLOW = saved
  }

  // 2. --repo selects another repository, resolved through git.
  {
    const dir = makeRepo()
    try {
      const parsed = parseScanArgs(['--repo', dir])
      assert.equal(parsed.repo, dir, '--repo must resolve to the git root')
      assert.equal(parseScanArgs([]).repo, repoRoot(), 'no flag means the caller\'s repo')
      assert.equal(parseScanArgs(['--install-hook']).install, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 3. THE OPERATOR'S COMMAND WORKS. `wednesday scan` — the harness bin, the
  //    one `npm i -g` installs — must dispatch the command, not read it as a
  //    build request.
  {
    const dir = makeRepo()
    try {
      stage(dir, 'app.js', 'export default 1\n')
      const run = spawnSync(process.execPath, [HARNESS_BIN, 'scan', '--repo', dir], {
        cwd: REPO,
        encoding: 'utf8',
      })
      assert.equal(
        run.status,
        0,
        'wednesday scan must exit 0 on a clean repo: ' +
          `${run.stdout || ''}${run.stderr || ''}`,
      )
      assert.ok(
        `${run.stdout}${run.stderr}`.includes('PASS'),
        'and it must say so',
      )
      // It must NOT have been read as a request: no task preview, no model.
      assert.ok(
        !`${run.stdout}${run.stderr}`.toLowerCase().includes('estimate'),
        'a scan must never queue a run',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 4. The internal CLI verb is the SAME command, not a second copy.
  {
    const dir = makeRepo()
    try {
      const literal = String.fromCharCode(39) + 'AKIA' + 'IOSFODNN7' + 'EXAMPLE' + String.fromCharCode(39)
      stage(dir, 'app.js', 'const k = ' + literal + ';\n')
      const run = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'scan', '--repo', dir], {
        cwd: REPO,
        encoding: 'utf8',
      })
      assert.equal(run.status, 1, 'the internal verb must block a staged secret')
      assert.ok(
        `${run.stdout}${run.stderr}`.includes('secret/aws-key'),
        'the internal verb must use the same rules',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 5. --install-hook writes a hook that calls the INSTALLED command.
  {
    const dir = makeRepo()
    try {
      const run = spawnSync(
        process.execPath,
        ['--import', 'tsx', CLI, 'scan', '--install-hook', '--repo', dir],
        { cwd: REPO, encoding: 'utf8' },
      )
      assert.equal(run.status, 0, 'installing the gate must exit 0')

      const path = join(dir, '.githooks', 'pre-commit')
      assert.ok(existsSync(path), 'the hook must be written where git expects it')
      const body = readFileSync(path, 'utf8')
      // The hook calls the operator-facing command, never a repo-local path
      // that would not exist in a foreign checkout.
      assert.ok(
        body.includes('wednesday scan --repo'),
        'the hook must call the installed command: ' + body.slice(-120),
      )
      assert.ok(
        body.includes('--no-verify'),
        'the hook must name the escape hatch',
      )
      assert.equal(
        sh(['config', 'core.hooksPath'], dir).trim(),
        '.githooks',
        'the hook must be installed by path, not copied into .git',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 6. The hook is fail-CLOSED when wednesday is not on PATH: a gate that
  //    cannot run is not a gate that passed.
  {
    const body = hookScript()
    assert.ok(
      body.includes('command -v wednesday'),
      'the hook must check for the binary',
    )
    assert.ok(
      body.includes('exit 1'),
      'a missing binary must fail the commit, not pass it',
    )
  }

  // 7. The gate never throws out of the module: a hook that crashes with a
  //    stack trace blocks the commit and tells the operator nothing.
  {
    const bad = mkdtempSync(join(tmpdir(), 'not-a-repo-'))
    try {
      const report = scanStaged(bad)
      assert.equal(
        report.disabled,
        false,
        'a directory with no git index is a clean scan, not a crash',
      )
      assert.equal(report.checked, 0)
      assert.equal(report.findings, 0)
    } finally {
      rmSync(bad, { recursive: true, force: true })
    }
  }

  console.log('scan-command: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
