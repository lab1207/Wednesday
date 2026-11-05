/**
 * Offline test for the SWE-bench Lite public-bench adapter. No network, no
 * model: a synthetic mini git repo proves workspace setup (clone at commit),
 * red grading (bug fails), green grading (hand fix passes) and test-file
 * revert; the real Lite board file (only when fetched at setup) gets a
 * structural check (300 rows, F2P/P2P present, no gold patch).
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  createSweBenchAdapter,
  loadSweRows,
  repoSlug,
  rowToProblem,
  setupSweWorkspace,
  SWE_GRADE_FILE,
  testPatchFiles,
  type SweRow,
} from './swebench'

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 120_000 })
  return stdout
}

const SYNTH_ROW: SweRow = {
  instance_id: 'synth__demo-1',
  repo: 'synth/demo',
  base_commit: '',
  environment_setup_commit: '',
  version: '0.0',
  problem_statement: 'double() returns 0 instead of twice the input.',
  hints_text: '',
  test_patch:
    'diff --git a/test_demo.py b/test_demo.py\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/test_demo.py\n@@ -0,0 +1,4 @@\n+from demo import double\n+\n+def test_double():\n+    assert double(21) == 42\n',
  fail_to_pass: ['test_demo.py::test_double'],
  pass_to_pass: [],
}

async function main(): Promise<void> {
  // 1. Slug + test-patch file extraction.
  assert.equal(repoSlug('psf/requests'), 'psf__requests')
  assert.deepEqual(testPatchFiles(SYNTH_ROW.test_patch), ['test_demo.py'])

  // 2. Conversion embeds the issue, never the tests.
  const problem = rowToProblem(SYNTH_ROW)
  assert.equal(problem.id, 'swe/synth__demo-1')
  assert.ok(problem.objective.includes('double() returns 0'))
  assert.ok(!problem.test.includes('gold'))

  // 3. Missing dataset path is a hard error.
  assert.throws(() => createSweBenchAdapter(''), /dataset path required/)

  // 4. Synthetic repo: red before fix, green after, tests reverted.
  const temp = await mkdtemp(join(tmpdir(), 'swe-adapter-'))
  try {
    const origin = join(temp, 'origin')
    await execFileAsync('git', ['init', '-b', 'main', origin], { timeout: 60_000 })
    await execFileAsync('git', ['-C', origin, 'config', 'user.email', 't@t'], { timeout: 60_000 })
    await execFileAsync('git', ['-C', origin, 'config', 'user.name', 't'], { timeout: 60_000 })
    await writeFile(join(origin, 'demo.py'), 'def double(n):\n    return 0\n', 'utf8')
    await git(origin, 'add', '-A')
    await git(origin, 'commit', '-m', 'base')
    const base = (await git(origin, 'rev-parse', 'HEAD')).trim()
    const row: SweRow = { ...SYNTH_ROW, base_commit: base }

    const reposRoot = join(temp, 'repos')
    await execFileAsync('git', ['clone', '--bare', origin, join(reposRoot, 'synth__demo')], { timeout: 120_000 })

    const wsProblem = rowToProblem(row)
    const ws = join(temp, 'ws')
    await setupSweWorkspace(ws, wsProblem, reposRoot)
    assert.equal((await git(ws, 'rev-parse', 'HEAD')).trim(), base)
    await readFile(join(ws, SWE_GRADE_FILE), 'utf8')

    const adapter = createSweBenchAdapter(join(temp, 'unused.jsonl'))
    const red = await adapter.grade(ws, wsProblem)
    assert.equal(red.passed, false, `bug should fail F2P: ${red.detail}`)
    // Test files reverted: later attempts never see them.
    let testVisible = true
    try {
      await readFile(join(ws, 'test_demo.py'), 'utf8')
    } catch {
      testVisible = false
    }
    assert.equal(testVisible, false, 'test patch files must be reverted after grading')

    await writeFile(join(ws, 'demo.py'), 'def double(n):\n    return n * 2\n', 'utf8')
    const green = await adapter.grade(ws, wsProblem)
    assert.equal(green.passed, true, `hand fix should pass: ${green.detail}`)

    // 5. Real board file (only when fetched at setup): structural check.
    const realPath = process.env.SWEBENCH_JSONL?.trim()
    if (realPath) {
      const realRows = await loadSweRows(realPath)
      assert.equal(realRows.length, 300, 'expected the full Lite split')
      for (const r of realRows) {
        assert.ok(r.instance_id && r.repo && r.base_commit, 'missing identity fields')
        assert.ok(r.fail_to_pass.length > 0, `empty F2P: ${r.instance_id}`)
        assert.ok(!('patch' in r), `gold patch leaked: ${r.instance_id}`)
      }
      console.log('  real-dataset structural check: PASS (300 rows, F2P present, no gold patch)')
    }

    console.log('SWEBENCH ADAPTER TEST: PASS')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
