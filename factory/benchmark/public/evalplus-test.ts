/**
 * Offline test for the EvalPlus public-bench adapter (HumanEval+ slice).
 * No network, no model: a synthetic row whose strengthened suite catches a
 * boundary bug (`<=` instead of `<`) that the base HumanEval asserts miss —
 * proving the upgrade is real — plus green/red/missing-file paths, the
 * MBPP+ loud rejection, and the missing-dataset error.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createEvalPlusAdapter,
  loadEvalPlusRows,
  rowToProblem,
  type EvalPlusRow,
} from './evalplus'
import { HUMANEVAL_SOLUTION_FILE } from './humaneval'

// Base HumanEval/0 asserts PLUS an exact-boundary case: with threshold 1.0
// and values exactly 1.0 apart, `<` answers False while `<=` answers True.
const ROW: EvalPlusRow = {
  task_id: 'HumanEval/0',
  prompt: 'def has_close_elements(numbers, threshold):\n    """ Check if in given list of numbers, are any two numbers closer to each other than\n    given threshold.\n    >>> has_close_elements([1.0, 2.0, 3.0], 0.5)\n    False\n    """\n',
  canonical_solution: '    for idx, elem in enumerate(numbers):\n        for idx2, elem2 in enumerate(numbers):\n            if idx != idx2:\n                distance = abs(elem - elem2)\n                if distance < threshold:\n                    return True\n\n    return False\n',
  test: `

def check(candidate):
    assert candidate([1.0, 2.0, 3.9, 4.0, 5.0, 2.2], 0.3) == True
    assert candidate([1.0, 2.0, 5.9, 4.0, 5.0], 0.95) == True
    assert candidate([1.0, 2.0, 3.0], 2.0) == True
    assert candidate([1.0, 2.0, 3.0], 1.0) == False
`,
  entry_point: 'has_close_elements',
}

// Subtly wrong: `<=` passes every base assert but fails the boundary case.
const BOUNDARY_BUG =
  ROW.prompt +
  '    for idx, elem in enumerate(numbers):\n        for idx2, elem2 in enumerate(numbers):\n            if idx != idx2:\n                distance = abs(elem - elem2)\n                if distance <= threshold:\n                    return True\n\n    return False\n'

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'evalplus-adapter-'))
  try {
    // 1. Loader: JSONL parse.
    const jsonlPath = join(temp, 'data.jsonl')
    await writeFile(jsonlPath, JSON.stringify(ROW) + '\n', 'utf8')
    const rows = await loadEvalPlusRows(jsonlPath)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].task_id, 'HumanEval/0')

    // 2. Conversion: objective carries the strengthened-suite warning.
    const problem = rowToProblem(rows[0])
    assert.ok(problem.objective.includes('def has_close_elements'))
    assert.ok(problem.objective.includes('STRENGTHENED'))
    assert.equal(problem.entryPoint, 'has_close_elements')

    const adapter = createEvalPlusAdapter(jsonlPath)

    // 3. GREEN: canonical solution passes the strengthened suite.
    const wsGreen = join(temp, 'ws-green')
    await mkdir(wsGreen, { recursive: true })
    await writeFile(
      join(wsGreen, HUMANEVAL_SOLUTION_FILE),
      ROW.prompt + ROW.canonical_solution,
      'utf8',
    )
    const g = await adapter.grade(wsGreen, problem)
    assert.equal(g.passed, true, `green grade failed: ${g.detail}`)
    assert.equal(g.problemId, 'HumanEval/0')

    // 4. RED (the upgrade proof): boundary bug passes base asserts but the
    //    strengthened suite catches it.
    const wsBug = join(temp, 'ws-bug')
    await mkdir(wsBug, { recursive: true })
    await writeFile(join(wsBug, HUMANEVAL_SOLUTION_FILE), BOUNDARY_BUG, 'utf8')
    const b = await adapter.grade(wsBug, problem)
    assert.equal(b.passed, false, 'strengthened suite must catch the boundary bug')
    assert.ok(b.detail.length > 0)

    // 5. RED: no solution file at all.
    const wsEmpty = join(temp, 'ws-empty')
    await mkdir(wsEmpty, { recursive: true })
    const e = await adapter.grade(wsEmpty, problem)
    assert.equal(e.passed, false)
    assert.ok(e.detail.includes('not found'))

    // 6. MBPP+ shape is rejected loudly, never misgraded.
    assert.throws(
      () =>
        rowToProblem({
          task_id: 'Mbpp/1',
          prompt: '',
          canonical_solution: '',
          test: '',
          entry_point: '',
          test_list: [],
        }),
      /MBPP\+.*queued/,
    )

    // 7. Missing dataset path is a hard error.
    assert.throws(() => createEvalPlusAdapter(''), /dataset path required/)

    console.log('EVALPLUS ADAPTER TEST: PASS (strengthened suite catches more)')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
