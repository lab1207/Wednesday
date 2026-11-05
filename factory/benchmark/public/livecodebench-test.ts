/**
 * Offline test for the LiveCodeBench public-bench adapter. No network, no
 * model: synthetic stdin problem proves loader, conversion, green grading,
 * red grading and the missing-dataset error path; the real v1 board file
 * (only when fetched at setup) gets a structural check plus a red grade.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createLiveCodeBenchAdapter,
  LCB_GRADE_FILE,
  LCB_SOLUTION_FILE,
  lcbGraderSeed,
  loadLcbRows,
  rowToProblem,
  type LcbRow,
} from './livecodebench'

const ROW: LcbRow = {
  id: 'synth-add',
  title: 'Add two integers',
  platform: 'synthetic',
  difficulty: 'easy',
  date: '2026-01-01',
  prompt: 'Read two integers from stdin, print their sum.',
  starter: '',
  fn_name: null,
  tests: [
    { input: '2 3\n', output: '5\n', testtype: 'stdin' },
    { input: '-1 1\n', output: '0\n', testtype: 'stdin' },
  ],
}

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'lcb-adapter-'))
  try {
    // 1. Loader: JSONL parse.
    const jsonlPath = join(temp, 'data.jsonl')
    await writeFile(jsonlPath, JSON.stringify(ROW) + '\n', 'utf8')
    const rows = await loadLcbRows(jsonlPath)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'synth-add')

    // 2. Conversion: objective embeds the prompt and the file contract.
    const problem = rowToProblem(rows[0])
    assert.ok(problem.objective.includes('Add two integers'))
    assert.ok(problem.objective.includes(LCB_SOLUTION_FILE))
    assert.equal(problem.id, 'lcb/synth-add')

    // 3. GREEN: correct stdin solution passes.
    const adapter = createLiveCodeBenchAdapter(jsonlPath)
    const wsGreen = join(temp, 'ws-green')
    await mkdir(wsGreen, { recursive: true })
    await writeFile(
      join(wsGreen, LCB_SOLUTION_FILE),
      'import sys\ndef main():\n    a, b = map(int, sys.stdin.read().split())\n    print(a + b)\nmain()\n',
      'utf8',
    )
    await writeFile(join(wsGreen, LCB_GRADE_FILE), lcbGraderSeed(problem), 'utf8')
    const g = await adapter.grade(wsGreen, problem)
    assert.equal(g.passed, true, `green grade failed: ${g.detail}`)

    // 4. RED: wrong solution fails.
    const wsRed = join(temp, 'ws-red')
    await mkdir(wsRed, { recursive: true })
    await writeFile(join(wsRed, LCB_SOLUTION_FILE), 'print(0)\n', 'utf8')
    await writeFile(join(wsRed, LCB_GRADE_FILE), lcbGraderSeed(problem), 'utf8')
    const r = await adapter.grade(wsRed, problem)
    assert.equal(r.passed, false)
    assert.ok(r.detail.length > 0)

    // 5. RED: no solution file at all.
    const wsEmpty = join(temp, 'ws-empty')
    await mkdir(wsEmpty, { recursive: true })
    await writeFile(join(wsEmpty, LCB_GRADE_FILE), lcbGraderSeed(problem), 'utf8')
    const e = await adapter.grade(wsEmpty, problem)
    assert.equal(e.passed, false)

    // 6. Missing dataset path is a hard error.
    assert.throws(() => createLiveCodeBenchAdapter(''), /dataset path required/)

    // 7. Real board file (only when fetched at setup): structural check +
    //    red grade with an empty solution on the first problem.
    const realPath = process.env.LIVECODEBENCH_JSONL?.trim()
    if (realPath) {
      const real = createLiveCodeBenchAdapter(realPath)
      const realProblems = await real.listProblems()
      assert.ok(realProblems.length >= 400, 'expected the full v1 board')
      const wsReal = join(temp, 'ws-real')
      await mkdir(wsReal, { recursive: true })
      await writeFile(join(wsReal, LCB_SOLUTION_FILE), 'print("")\n', 'utf8')
      await writeFile(
        join(wsReal, LCB_GRADE_FILE), lcbGraderSeed(realProblems[0]), 'utf8',
      )
      const red0 = await real.grade(wsReal, realProblems[0])
      assert.equal(red0.passed, false, 'empty solution should fail board tests')
      console.log(`  real-dataset structural+red check: PASS (${realProblems.length} problems)`)
    }

    console.log('LIVECODEBENCH ADAPTER TEST: PASS')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
