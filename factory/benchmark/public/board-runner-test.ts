/**
 * Offline test for the public-board runner (HumanEval). No network, no
 * model. Two proofs:
 *
 * 1. GRADER SEED GREEN/RED — the seeded grade_solution.py passes the
 *    canonical solution and fails a wrong one, so Factory verification
 *    would reward a correct coder. This is the measuring stick inside
 *    the production loop.
 * 2. OFFLINE RED RUN — the full loop (problem → Hermes → FactoryService →
 *    verification → grade → records) runs under the deterministic coder
 *    and must come out red with intact plumbing (exit 0, evidence written,
 *    summary 0/N). Mirrors factory/benchmark/test.ts conventions.
 */

import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { graderSeed } from './board-runner'
import { loadHumanEvalRows, type HumanEvalRow } from './humaneval'
import { pythonBin } from './run-python'

const ROWS: HumanEvalRow[] = [
  {
    task_id: 'mini/0',
    prompt: 'def add_two(a: float, b: float) -> float:\n    """Return the sum of a and b."""\n',
    canonical_solution: '    return a + b\n',
    test: 'def check(candidate):\n    assert candidate(2, 3) == 5\n    assert candidate(-1, 1) == 0\n',
    entry_point: 'add_two',
  },
  {
    task_id: 'mini/1',
    prompt: 'def is_even(n: int) -> bool:\n    """Return True exactly when n is even."""\n',
    canonical_solution: '    return n % 2 == 0\n',
    test: 'def check(candidate):\n    assert candidate(0) is True\n    assert candidate(7) is False\n',
    entry_point: 'is_even',
  },
]

function runPythonIn(dir: string, script: string): number {
  const result = spawnSync(pythonBin(), [script], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  })
  return result.status ?? -1
}

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'board-runner-'))
  try {
    const datasetPath = join(temp, 'mini.jsonl')
    await writeFile(datasetPath, ROWS.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    const rows = await loadHumanEvalRows(datasetPath)
    assert.equal(rows.length, 2)

    // --- 1. Grader seed: green for canonical, red for wrong. ---
    const problem = { id: rows[0].task_id, objective: 'x', test: rows[0].test, entryPoint: rows[0].entry_point }
    const goodWs = join(temp, 'ws-good')
    await mkdir(goodWs, { recursive: true })
    await writeFile(join(goodWs, 'solution.py'), rows[0].prompt + rows[0].canonical_solution, 'utf8')
    await writeFile(join(goodWs, 'grade_solution.py'), graderSeed(problem), 'utf8')
    assert.equal(
      runPythonIn(goodWs, 'grade_solution.py'), 0,
      'grader seed must pass the canonical solution (else the loop cannot reward a correct coder)',
    )

    const badWs = join(temp, 'ws-bad')
    await mkdir(badWs, { recursive: true })
    await writeFile(join(badWs, 'solution.py'), rows[0].prompt + '    return a - b\n', 'utf8')
    await writeFile(join(badWs, 'grade_solution.py'), graderSeed(problem), 'utf8')
    assert.notEqual(runPythonIn(badWs, 'grade_solution.py'), 0, 'grader seed must fail a wrong solution')

    // --- 2. Offline red run of the full loop. ---
    const outRoot = join(temp, 'out')
    const state = join(temp, 'state')
    const cli = fileURLToPath(new URL('./run-board.ts', import.meta.url))
    const child = spawnSync(
      process.execPath,
      [
        ...process.execArgv,
        cli,
        '--board', 'humaneval',
        '--dataset', datasetPath,
        '--mode', 'deterministic',
        '--limit', '2',
        '--out', outRoot,
      ],
      {
        encoding: 'utf8',
        timeout: 300_000,
        windowsHide: true,
        env: {
          ...process.env,
          FACTORY_EXECUTION_MODE: 'deterministic',
          HERMES_TASKS_PATH: join(state, 'tasks.json'),
          FACTORY_EVENTS_PATH: join(state, 'events.jsonl'),
          WEDNESDAY_STATE_HOME: state,
          WEDNESDAY_BENCHMARK_HOME: outRoot,
        },
      },
    )
    assert.ifError(child.error)
    assert.equal(child.status, 0, `board CLI exited ${child.status}: ${child.stderr?.slice(-2000)}`)

    const boardDir = join(outRoot, 'humaneval')
    const batches = await readdir(boardDir)
    assert.equal(batches.length, 1)
    const batchDir = join(boardDir, batches[0])

    const summary = JSON.parse(await readFile(join(batchDir, 'summary.json'), 'utf8'))
    assert.equal(summary.total, 2)
    assert.equal(summary.passed, 0, 'deterministic coder must not solve board problems')
    assert.equal(summary.mode, 'deterministic')
    assert.equal(summary.board, 'humaneval')
    assert.equal(summary.model, 'deterministic', 'offline batches must carry the deterministic label')
    assert.equal(summary.serving.provider, 'deterministic')
    assert.match(summary.serving.temperature, /upstream-default/)
    assert.equal(summary.serving.contextWindow, null, 'offline batches carry no context ceiling')

    const recordsRaw = await readFile(join(batchDir, 'records.jsonl'), 'utf8')
    const records = recordsRaw.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(records.length, 2)
    for (const record of records) {
      assert.equal(record.boardGrade.passed, false, 'expected red board grade')
      assert.equal(record.verificationPassed, false, 'expected red factory verification')
      assert.ok(existsSync(join(record.runDir, 'evidence.json')), 'per-problem evidence missing')
      assert.ok(existsSync(join(record.workspace, 'grade_solution.py')), 'grader seed missing from workspace')
    }

    console.log('BOARD RUNNER TEST: PASS (offline red as designed)')

    // --- 3. Aider board: grader driver green/red + deterministic red loop. ---
    const polyRoot = join(temp, 'polyglot')
    const demoDir = join(polyRoot, 'python', 'exercises', 'practice', 'demo')
    await mkdir(join(demoDir, '.docs'), { recursive: true })
    await writeFile(join(demoDir, 'demo.py'), 'def double(n):\n    return 0\n', 'utf8')
    await writeFile(
      join(demoDir, 'demo_test.py'),
      'import unittest\nfrom demo import double\n\n\nclass DemoTest(unittest.TestCase):\n    def test_double(self):\n        self.assertEqual(double(21), 42)\n',
      'utf8',
    )
    await writeFile(join(demoDir, '.docs', 'instructions.md'), '# Demo\n\nReturn double the input.\n', 'utf8')

    const { createAiderAdapter, setupAiderWorkspace } = await import('./aider')
    const aiderAdapter = createAiderAdapter(polyRoot, ['python'])
    const aiderProblems = await aiderAdapter.listProblems()
    assert.equal(aiderProblems.length, 1)
    const aiderProblem = aiderProblems[0]
    assert.equal(aiderProblem.id, 'aider/python/demo')

    const aiderGood = join(temp, 'ws-aider-good')
    await setupAiderWorkspace(aiderGood, aiderProblem, polyRoot)
    assert.ok(!existsSync(join(aiderGood, 'demo_test.py')), 'tests must stay hidden until grade time')
    await writeFile(join(aiderGood, 'demo.py'), 'def double(n):\n    return n * 2\n', 'utf8')
    const aiderGreen = await aiderAdapter.grade(aiderGood, aiderProblem)
    assert.equal(aiderGreen.passed, true, `aider driver must pass canonical: ${aiderGreen.detail}`)

    const aiderBad = join(temp, 'ws-aider-bad')
    await setupAiderWorkspace(aiderBad, aiderProblem, polyRoot)
    const aiderRed = await aiderAdapter.grade(aiderBad, aiderProblem)
    assert.equal(aiderRed.passed, false, 'aider driver must fail the stub')

    const aiderChild = spawnSync(
      process.execPath,
      [
        ...process.execArgv,
        cli,
        '--board', 'aider',
        '--dataset', polyRoot,
        '--mode', 'deterministic',
        '--limit', '1',
        '--out', join(temp, 'out-aider'),
      ],
      {
        encoding: 'utf8',
        timeout: 300_000,
        windowsHide: true,
        env: {
          ...process.env,
          FACTORY_EXECUTION_MODE: 'deterministic',
          HERMES_TASKS_PATH: join(state, 'tasks.json'),
          FACTORY_EVENTS_PATH: join(state, 'events.jsonl'),
          WEDNESDAY_STATE_HOME: state,
          WEDNESDAY_BENCHMARK_HOME: join(temp, 'out-aider'),
        },
      },
    )
    assert.ifError(aiderChild.error)
    assert.equal(aiderChild.status, 0, `aider board CLI exited ${aiderChild.status}: ${aiderChild.stderr?.slice(-2000)}`)
    const aiderBatches = await readdir(join(temp, 'out-aider', 'aider'))
    assert.equal(aiderBatches.length, 1)
    const aiderSummary = JSON.parse(
      await readFile(join(temp, 'out-aider', 'aider', aiderBatches[0], 'summary.json'), 'utf8'),
    )
    assert.equal(aiderSummary.total, 1)
    assert.equal(aiderSummary.passed, 0, 'deterministic coder must not solve aider problems')
    assert.equal(aiderSummary.board, 'aider')
    const aiderRecords = (await readFile(
      join(temp, 'out-aider', 'aider', aiderBatches[0], 'records.jsonl'), 'utf8',
    )).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(aiderRecords[0].boardGrade.passed, false)
    assert.equal(aiderRecords[0].verificationPassed, false)
    assert.ok(
      existsSync(join(aiderRecords[0].workspace, 'grade_aider.py')),
      'aider grader driver missing from workspace',
    )

    console.log('BOARD RUNNER TEST: PASS (offline red as designed, humaneval + aider)')

    // --- 4. LiveCodeBench board: synthetic problem + deterministic red loop. ---
    const lcbDataset = join(temp, 'lcb.jsonl')
    await writeFile(lcbDataset, JSON.stringify({
      id: 'synth-add',
      title: 'Add two integers',
      platform: 'synthetic',
      difficulty: 'easy',
      date: '2026-01-01',
      prompt: 'Read two integers from stdin, print their sum.',
      starter: '',
      fn_name: null,
      tests: [{ input: '2 3\n', output: '5\n', testtype: 'stdin' }],
    }) + '\n', 'utf8')
    const lcbChild = spawnSync(
      process.execPath,
      [
        ...process.execArgv,
        cli,
        '--board', 'livecodebench',
        '--dataset', lcbDataset,
        '--mode', 'deterministic',
        '--limit', '1',
        '--out', join(temp, 'out-lcb'),
      ],
      {
        encoding: 'utf8',
        timeout: 300_000,
        windowsHide: true,
        env: {
          ...process.env,
          FACTORY_EXECUTION_MODE: 'deterministic',
          HERMES_TASKS_PATH: join(state, 'tasks.json'),
          FACTORY_EVENTS_PATH: join(state, 'events.jsonl'),
          WEDNESDAY_STATE_HOME: state,
          WEDNESDAY_BENCHMARK_HOME: join(temp, 'out-lcb'),
        },
      },
    )
    assert.ifError(lcbChild.error)
    assert.equal(lcbChild.status, 0, `lcb board CLI exited ${lcbChild.status}: ${lcbChild.stderr?.slice(-2000)}`)
    const lcbBatches = await readdir(join(temp, 'out-lcb', 'livecodebench'))
    assert.equal(lcbBatches.length, 1)
    const lcbSummary = JSON.parse(
      await readFile(join(temp, 'out-lcb', 'livecodebench', lcbBatches[0], 'summary.json'), 'utf8'),
    )
    assert.equal(lcbSummary.total, 1)
    assert.equal(lcbSummary.passed, 0, 'deterministic coder must not solve lcb problems')
    assert.equal(lcbSummary.board, 'livecodebench')
    const lcbRecords = (await readFile(
      join(temp, 'out-lcb', 'livecodebench', lcbBatches[0], 'records.jsonl'), 'utf8',
    )).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(lcbRecords[0].boardGrade.passed, false)
    assert.equal(lcbRecords[0].verificationPassed, false)
    assert.ok(
      existsSync(join(lcbRecords[0].workspace, 'grade_lcb.py')),
      'lcb grader driver missing from workspace',
    )

    console.log('BOARD RUNNER TEST: PASS (offline red as designed, humaneval + aider + livecodebench)')

    // --- 5. SWE-bench board: synthetic mini repo + deterministic red loop. ---
    const execFileAsync = promisify(execFile)
    const gitInit = async (args: string[]): Promise<void> => {
      await execFileAsync('git', args, { timeout: 60_000, windowsHide: true })
    }
    const sweOrigin = join(temp, 'swe-origin')
    await gitInit(['init', '-b', 'main', sweOrigin])
    await gitInit(['-C', sweOrigin, 'config', 'user.email', 't@t'])
    await gitInit(['-C', sweOrigin, 'config', 'user.name', 't'])
    await writeFile(join(sweOrigin, 'demo.py'), 'def double(n):\n    return 0\n', 'utf8')
    await gitInit(['-C', sweOrigin, 'add', '-A'])
    await gitInit(['-C', sweOrigin, 'commit', '-m', 'base'])
    const sweRepos = join(temp, 'swe-repos')
    await gitInit(['clone', '--bare', sweOrigin, join(sweRepos, 'synth__demo')])
    const sweDataset = join(temp, 'swe.jsonl')
    await writeFile(sweDataset, JSON.stringify({
      instance_id: 'synth__demo-1',
      repo: 'synth/demo',
      base_commit: 'HEAD',
      environment_setup_commit: '',
      version: '0.0',
      problem_statement: 'double() returns 0 instead of twice the input.',
      hints_text: '',
      test_patch: 'diff --git a/test_demo.py b/test_demo.py\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/test_demo.py\n@@ -0,0 +1,4 @@\n+from demo import double\n+\n+def test_double():\n+    assert double(21) == 42\n',
      fail_to_pass: ['test_demo.py::test_double'],
      pass_to_pass: [],
    }) + '\n', 'utf8')
    const sweChild = spawnSync(
      process.execPath,
      [
        ...process.execArgv,
        cli,
        '--board', 'swebench',
        '--dataset', sweDataset,
        '--mode', 'deterministic',
        '--limit', '1',
        '--out', join(temp, 'out-swe'),
      ],
      {
        encoding: 'utf8',
        timeout: 600_000,
        windowsHide: true,
        env: {
          ...process.env,
          FACTORY_EXECUTION_MODE: 'deterministic',
          HERMES_TASKS_PATH: join(state, 'tasks.json'),
          FACTORY_EVENTS_PATH: join(state, 'events.jsonl'),
          WEDNESDAY_STATE_HOME: state,
          WEDNESDAY_BENCHMARK_HOME: join(temp, 'out-swe'),
          SWEBENCH_REPOS_ROOT: sweRepos,
        },
      },
    )
    assert.ifError(sweChild.error)
    assert.equal(sweChild.status, 0, `swe board CLI exited ${sweChild.status}: ${sweChild.stderr?.slice(-2000)}`)
    const sweBatches = await readdir(join(temp, 'out-swe', 'swebench'))
    assert.equal(sweBatches.length, 1)
    const sweSummary = JSON.parse(
      await readFile(join(temp, 'out-swe', 'swebench', sweBatches[0], 'summary.json'), 'utf8'),
    )
    assert.equal(sweSummary.total, 1)
    assert.equal(sweSummary.passed, 0, 'deterministic coder must not resolve swe instances')
    assert.equal(sweSummary.board, 'swebench')
    const sweRecords = (await readFile(
      join(temp, 'out-swe', 'swebench', sweBatches[0], 'records.jsonl'), 'utf8',
    )).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(sweRecords[0].boardGrade.passed, false)
    assert.equal(sweRecords[0].verificationPassed, false)
    assert.ok(
      existsSync(join(sweRecords[0].workspace, 'grade_swe.py')),
      'swe grader driver missing from workspace',
    )

    console.log('BOARD RUNNER TEST: PASS (offline red as designed, all 4 boards)')

    // --- 6. runUntilPass: early stop on first pass, budget respected. ---
    const { runUntilPass } = await import('./board-runner')
    let calls = 0
    const firstPass = await runUntilPass(async () => ({ passed: true }), 5)
    assert.deepEqual(firstPass, { passed: true, samplesUsed: 1 })
    calls = 0
    const thirdPass = await runUntilPass(async () => {
      calls += 1
      return { passed: calls >= 3 }
    }, 5)
    assert.deepEqual(thirdPass, { passed: true, samplesUsed: 3 })
    const allFail = await runUntilPass(async () => ({ passed: false }), 4)
    assert.deepEqual(allFail, { passed: false, samplesUsed: 4 })
    const zeroBudget = await runUntilPass(async () => ({ passed: false }), 0)
    assert.deepEqual(zeroBudget, { passed: false, samplesUsed: 1 }, 'budget floors at 1')

    // --- 7. Deterministic loop with --samples 2: two red attempts recorded. ---
    const samplesChild = spawnSync(
      process.execPath,
      [
        ...process.execArgv,
        cli,
        '--board', 'humaneval',
        '--dataset', datasetPath,
        '--mode', 'deterministic',
        '--limit', '1',
        '--samples', '2',
        '--out', join(temp, 'out-samples'),
      ],
      {
        encoding: 'utf8',
        timeout: 300_000,
        windowsHide: true,
        env: {
          ...process.env,
          FACTORY_EXECUTION_MODE: 'deterministic',
          HERMES_TASKS_PATH: join(state, 'tasks.json'),
          FACTORY_EVENTS_PATH: join(state, 'events.jsonl'),
          WEDNESDAY_STATE_HOME: state,
          WEDNESDAY_BENCHMARK_HOME: join(temp, 'out-samples'),
        },
      },
    )
    assert.ifError(samplesChild.error)
    assert.equal(samplesChild.status, 0, `samples CLI exited ${samplesChild.status}: ${samplesChild.stderr?.slice(-2000)}`)
    const samplesBatches = await readdir(join(temp, 'out-samples', 'humaneval'))
    assert.equal(samplesBatches.length, 1)
    const samplesSummary = JSON.parse(
      await readFile(join(temp, 'out-samples', 'humaneval', samplesBatches[0], 'summary.json'), 'utf8'),
    )
    assert.equal(samplesSummary.total, 1)
    assert.equal(samplesSummary.passed, 0)
    assert.equal(samplesSummary.samplesUsed, 2, 'both samples must run when nothing passes')
    const samplesRecords = (await readFile(
      join(temp, 'out-samples', 'humaneval', samplesBatches[0], 'records.jsonl'), 'utf8',
    )).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(samplesRecords[0].samplesUsed, 2)
    assert.equal(samplesRecords[0].boardGrade.passed, false)
    assert.ok(
      existsSync(join(samplesRecords[0].runDir, 'evidence.json')),
      'aggregate problem evidence missing',
    )

    console.log('BOARD RUNNER TEST: PASS (offline red as designed, all 4 boards + pass@k)')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
