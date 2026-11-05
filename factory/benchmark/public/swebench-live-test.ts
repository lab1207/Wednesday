/**
 * Offline test for the SWE-bench-Live adapter (Python split). No network,
 * no model: an upstream-shaped synthetic row (FAIL_TO_PASS/PASS_TO_PASS +
 * test_cmds + gold `patch`) proves normalization, gold refusal, id
 * namespacing, and red/green grading through the shared pytest driver.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  createSweLiveAdapter,
  liveRowToProblem,
  loadLiveRows,
  normalizeLiveRow,
  type LiveUpstreamRow,
} from './swebench-live'
import { setupSweWorkspace } from './swebench'

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 120_000 })
  return stdout
}

const UPSTREAM: LiveUpstreamRow = {
  instance_id: 'synth__demo-1',
  repo: 'synth/demo',
  base_commit: '',
  problem_statement: 'double() returns 0 instead of twice the input.',
  hints_text: '',
  test_patch:
    'diff --git a/test_demo.py b/test_demo.py\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/test_demo.py\n@@ -0,0 +1,4 @@\n+from demo import double\n+\n+def test_double():\n+    assert double(21) == 42\n',
  FAIL_TO_PASS: ['test_demo.py::test_double'],
  PASS_TO_PASS: [],
  test_cmds: ['pytest test_demo.py::test_double'],
  log_parser: 'pytest',
  patch: 'diff --git a/demo.py b/demo.py\n--- a/demo.py\n+++ b/demo.py\n@@\n-    return 0\n+    return 2 * n\n',
}

async function main(): Promise<void> {
  // 1. Normalization: lists mapped, gold dropped, id namespaced.
  const row = normalizeLiveRow(UPSTREAM)
  assert.deepEqual(row.fail_to_pass, ['test_demo.py::test_double'])
  assert.ok(!('patch' in row), 'gold patch must not survive normalization')
  const problem = liveRowToProblem(row)
  assert.equal(problem.id, 'swe-live/synth__demo-1')
  assert.ok(problem.objective.includes('double() returns 0'))
  assert.ok(!problem.test.includes('return 2 * n'), 'gold must not reach the task')

  // 2. Ungradable rows fail loudly.
  assert.throws(
    () => normalizeLiveRow({ ...UPSTREAM, PASS_TO_PASS: undefined as never }),
    /ungradable/,
  )

  // 3. Gold-on-disk file is refused at load.
  const temp = await mkdtemp(join(tmpdir(), 'swe-live-adapter-'))
  try {
    const goldPath = join(temp, 'gold.jsonl')
    await writeFile(goldPath, JSON.stringify(UPSTREAM) + '\n', 'utf8')
    await assert.rejects(loadLiveRows(goldPath), /strip 'patch'/)
    const { patch: _dropped, ...clean } = UPSTREAM
    void _dropped
    const cleanPath = join(temp, 'clean.jsonl')
    await writeFile(cleanPath, JSON.stringify(clean) + '\n', 'utf8')
    assert.equal((await loadLiveRows(cleanPath)).length, 1)

    // 4. Synthetic repo: red before fix, green after (shared driver).
    const origin = join(temp, 'origin')
    await execFileAsync('git', ['init', '-b', 'main', origin], { timeout: 60_000 })
    await execFileAsync('git', ['-C', origin, 'config', 'user.email', 't@t'], { timeout: 60_000 })
    await execFileAsync('git', ['-C', origin, 'config', 'user.name', 't'], { timeout: 60_000 })
    await writeFile(join(origin, 'demo.py'), 'def double(n):\n    return 0\n', 'utf8')
    await git(origin, 'add', '-A')
    await git(origin, 'commit', '-m', 'base')
    const base = (await git(origin, 'rev-parse', 'HEAD')).trim()

    const reposRoot = join(temp, 'repos')
    await execFileAsync('git', ['clone', '--bare', origin, join(reposRoot, 'synth__demo')], { timeout: 120_000 })

    const wsProblem = liveRowToProblem({ ...row, base_commit: base })
    const ws = join(temp, 'ws')
    await setupSweWorkspace(ws, wsProblem, reposRoot)
    assert.equal((await git(ws, 'rev-parse', 'HEAD')).trim(), base)

    const adapter = createSweLiveAdapter(cleanPath)
    const red = await adapter.grade(ws, wsProblem)
    assert.equal(red.passed, false, `bug should fail F2P: ${red.detail}`)

    await writeFile(join(ws, 'demo.py'), 'def double(n):\n    return 2 * n\n', 'utf8')
    const green = await adapter.grade(ws, wsProblem)
    assert.equal(green.passed, true, `hand fix should pass: ${green.detail}`)

    // 5. Missing dataset path is a hard error.
    assert.throws(() => createSweLiveAdapter(''), /dataset path required/)

    console.log('SWE-LIVE ADAPTER TEST: PASS (normalize + gold refusal + red/green)')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
