/**
 * Offline test for the Multi-SWE-bench adapter (rust slice). No network
 * (except host cargo for the red/green proof — no deps, offline-safe):
 * an upstream-shaped synthetic row (f2p/p2p maps + gold fix_patch)
 * proves normalization, gold refusal, id namespacing, and red/green
 * grading through the cargo driver on a mini crate.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  createMultiSweAdapter,
  loadMultiSweRows,
  multiSweRowToProblem,
  multiSweTestFiles,
  normalizeMultiSweRow,
  setupMultiSweWorkspace,
  type MultiSweUpstreamRow,
} from './multi-swe'

const execFileAsync = promisify(execFile)

/** System linker present (cargo test links binaries — no linker, no green). */
async function hasLinker(): Promise<boolean> {
  const probe = process.platform === 'win32'
    ? ['where', ['link.exe']]
    : ['which', ['cc']]
  try {
    await execFileAsync(probe[0], probe[1] as string[], { timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 120_000 })
  return stdout
}

const UPSTREAM: MultiSweUpstreamRow = {
  instance_id: 'synth__demo-1',
  org: 'synth',
  repo: 'demo',
  base: { sha: '' },
  title: 'double() returns 0 instead of twice the input',
  body: 'double(21) should be 42.',
  test_patch:
    'diff --git a/tests/test_double.rs b/tests/test_double.rs\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/tests/test_double.rs\n@@ -0,0 +1,4 @@\n+#[test]\n+fn test_double() {\n+    assert_eq!(42, demo::double(21));\n+}\n',
  f2p_tests: { test_double: { run: 'NONE', test: 'FAIL', fix: 'PASS' } },
  p2p_tests: {},
  fix_patch: 'diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@\n-0\n+2 * n\n',
}

const CRATE = '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n'
const BUGGY_LIB = 'pub fn double(n: i32) -> i32 {\n    0\n}\n'

async function main(): Promise<void> {
  // 1. Normalization: name maps → lists, gold dropped, repo slugged.
  const row = normalizeMultiSweRow(UPSTREAM)
  assert.deepEqual(row.fail_to_pass, ['test_double'])
  assert.deepEqual(row.pass_to_pass, [])
  assert.equal(row.repo, 'synth/demo')
  assert.ok(!('fix_patch' in row), 'gold must not survive normalization')
  assert.deepEqual(multiSweTestFiles(UPSTREAM.test_patch), ['tests/test_double.rs'])
  const problem = multiSweRowToProblem(row)
  assert.equal(problem.id, 'multi-swe/synth__demo-1')
  assert.ok(problem.objective.includes('double() returns 0'))
  assert.ok(!problem.test.includes('2 * n'), 'gold must not reach the task')

  // 2. Ungradable rows fail loudly.
  assert.throws(
    () => normalizeMultiSweRow({ ...UPSTREAM, f2p_tests: undefined as never }),
    /ungradable/,
  )

  // 3. Gold-on-disk file is refused at load.
  const temp = await mkdtemp(join(tmpdir(), 'multiswe-adapter-'))
  try {
    const goldPath = join(temp, 'gold.jsonl')
    await writeFile(goldPath, JSON.stringify(UPSTREAM) + '\n', 'utf8')
    await assert.rejects(loadMultiSweRows(goldPath), /strip 'fix_patch'/)
    const { fix_patch: _dropped, ...clean } = UPSTREAM
    void _dropped
    const cleanPath = join(temp, 'clean.jsonl')
    await writeFile(cleanPath, JSON.stringify(clean) + '\n', 'utf8')
    assert.equal((await loadMultiSweRows(cleanPath)).length, 1)

    // 4. Mini crate: red before fix, green after (cargo driver).
    const origin = join(temp, 'origin')
    await mkdir(join(origin, 'src'), { recursive: true })
    await execFileAsync('git', ['init', '-b', 'main', origin], { timeout: 60_000 })
    await execFileAsync('git', ['-C', origin, 'config', 'user.email', 't@t'], { timeout: 60_000 })
    await execFileAsync('git', ['-C', origin, 'config', 'user.name', 't'], { timeout: 60_000 })
    await writeFile(join(origin, 'Cargo.toml'), CRATE, 'utf8')
    await writeFile(join(origin, 'src', 'lib.rs'), BUGGY_LIB, 'utf8')
    await git(origin, 'add', '-A')
    await git(origin, 'commit', '-m', 'base')
    const base = (await git(origin, 'rev-parse', 'HEAD')).trim()

    const reposRoot = join(temp, 'repos')
    await execFileAsync('git', ['clone', '--bare', origin, join(reposRoot, 'synth__demo')], { timeout: 120_000 })

    const wsProblem = multiSweRowToProblem({ ...row, base_commit: base })
    const ws = join(temp, 'ws')
    await setupMultiSweWorkspace(ws, wsProblem, reposRoot)
    assert.equal((await git(ws, 'rev-parse', 'HEAD')).trim(), base)

    const adapter = createMultiSweAdapter(cleanPath)
    const red = await adapter.grade(ws, wsProblem)
    assert.equal(red.passed, false, `bug should fail F2P: ${red.detail}`)

    await writeFile(join(ws, 'src', 'lib.rs'), 'pub fn double(n: i32) -> i32 {\n    2 * n\n}\n', 'utf8')

    // Green needs a working link step (MSVC link.exe on Windows, cc on
    // unix) — a MACHINE setup requirement, not adapter logic. Suites with
    // missing toolchains skip green loudly (same precedent as key-gated
    // live suites); red above already proves the driver end to end.
    if (await hasLinker()) {
      const green = await adapter.grade(ws, wsProblem)
      assert.equal(green.passed, true, `hand fix should pass: ${green.detail}`)
    } else {
      console.log('  green proof SKIPPED: no system linker (install VS Build Tools or run in Docker)')
    }

    // 5. Missing dataset path is a hard error.
    assert.throws(() => createMultiSweAdapter(''), /dataset path required/)

    console.log('MULTISWE ADAPTER TEST: PASS (normalize + gold refusal + cargo red; green linker-gated)')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
