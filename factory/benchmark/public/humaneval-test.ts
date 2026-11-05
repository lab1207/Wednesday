/**
 * Offline test for the HumanEval public-bench adapter. No network, no
 * model: uses a synthetic two-row dataset (canonical HumanEval problem 0)
 * and python to prove loader, conversion, green grading, red grading and
 * the missing-dataset error path.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createHumanEvalAdapter,
  HUMANEVAL_SOLUTION_FILE,
  loadHumanEvalRows,
  rowToProblem,
  type HumanEvalRow,
} from './humaneval'

const ROW: HumanEvalRow = {
  task_id: 'HumanEval/0',
  prompt: 'def has_close_elements(numbers, threshold):\n    """ Check if in given list of numbers, are any two numbers closer to each other than\n    given threshold.\n    >>> has_close_elements([1.0, 2.0, 3.0], 0.5)\n    False\n    """\n',
  canonical_solution: '    for idx, elem in enumerate(numbers):\n        for idx2, elem2 in enumerate(numbers):\n            if idx != idx2:\n                distance = abs(elem - elem2)\n                if distance < threshold:\n                    return True\n\n    return False\n',
  test: `

def check(candidate):
    assert candidate([1.0, 2.0, 3.9, 4.0, 5.0, 2.2], 0.3) == True
    assert candidate([1.0, 2.0, 5.9, 4.0, 5.0], 0.95) == True
    assert candidate([1.0, 2.0, 3.0], 2.0) == True
`,
  entry_point: 'has_close_elements',
}

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'humaneval-adapter-'))
  try {
    // 1. Loader: JSONL parse.
    const jsonlPath = join(temp, 'data.jsonl')
    await writeFile(jsonlPath, JSON.stringify(ROW) + '\n', 'utf8')
    const rows = await loadHumanEvalRows(jsonlPath)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].task_id, 'HumanEval/0')

    // 2. Conversion: objective embeds the board prompt and the file contract.
    const problem = rowToProblem(rows[0])
    assert.ok(problem.objective.includes('def has_close_elements'))
    assert.ok(problem.objective.includes(HUMANEVAL_SOLUTION_FILE))
    assert.equal(problem.entryPoint, 'has_close_elements')

    // 3. GREEN: canonical solution passes the board's own asserts.
    const green = await createHumanEvalAdapter(jsonlPath)
    const wsGreen = join(temp, 'ws-green')
    await mkdir(wsGreen, { recursive: true })
    await writeFile(
      join(wsGreen, HUMANEVAL_SOLUTION_FILE),
      ROW.prompt + ROW.canonical_solution,
      'utf8',
    )
    const g = await green.grade(wsGreen, problem)
    assert.equal(g.passed, true, `green grade failed: ${g.detail}`)
    assert.equal(g.problemId, 'HumanEval/0')

    // 4. RED: wrong solution fails the board asserts.
    const wsRed = join(temp, 'ws-red')
    await mkdir(wsRed, { recursive: true })
    await writeFile(
      join(wsRed, HUMANEVAL_SOLUTION_FILE),
      ROW.prompt + '    return False\n',
      'utf8',
    )
    const r = await green.grade(wsRed, problem)
    assert.equal(r.passed, false)
    assert.ok(r.detail.length > 0)

    // 5. RED: no solution file at all.
    const wsEmpty = join(temp, 'ws-empty')
    await mkdir(wsEmpty, { recursive: true })
    const e = await green.grade(wsEmpty, problem)
    assert.equal(e.passed, false)
    assert.ok(e.detail.includes('not found'))

    // 6. Missing dataset path is a hard error.
    assert.throws(() => createHumanEvalAdapter(''), /dataset path required/)

    // 7. Real dataset (only when fetched at setup): canonical solution of
    //    problem 0 must pass the board's own asserts.
    const realPath = process.env.HUMANEVAL_JSONL?.trim()
    if (realPath) {
      const real = createHumanEvalAdapter(realPath)
      const realProblems = await real.listProblems()
      assert.ok(realProblems.length >= 164, 'expected the full 164-problem board')
      const wsReal = join(temp, 'ws-real')
      await mkdir(wsReal, { recursive: true })
      const row0 = (await loadHumanEvalRows(realPath))[0]
      await writeFile(
        join(wsReal, HUMANEVAL_SOLUTION_FILE),
        row0.prompt + row0.canonical_solution,
        'utf8',
      )
      const g0 = await real.grade(wsReal, realProblems[0])
      assert.equal(g0.passed, true, `real canonical grade failed: ${g0.detail}`)
      console.log(`  real-dataset canonical check: PASS (${realProblems.length} problems)`)
    }

    console.log('HUMANEVAL ADAPTER TEST: PASS')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
