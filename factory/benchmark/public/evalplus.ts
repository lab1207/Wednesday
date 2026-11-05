/**
 * EvalPlus adapter — Tier-1 board (HumanEval+ slice).
 *
 * EvalPlus (evalplus/evalplus, open): HumanEval+ (164 problems, ~80x more
 * tests than HumanEval) + MBPP+ (~399). The strengthened suites catch
 * wrong solutions that pass the base asserts — exactly the "base green,
 * plus red" upgrade a repair-loop factory wants to be graded by.
 *
 * v1 scope: HumanEval+ rows only. Upstream HumanEvalPlus.jsonl rows carry
 * the SAME fields as HumanEval ({task_id, prompt, canonical_solution,
 * test, entry_point}) with a much larger `test` body, so grading reuses
 * the solution.py + check(entry_point) contract verbatim. MBPP+ rows have
 * a different shape (test_list, no entry_point) and stay queued until a
 * dedicated contract is built — the adapter rejects them loudly rather
 * than misgrading.
 *
 * Dataset: JSONL fetched at setup into a gitignored path (EVALPLUS_JSONL
 * env or argument). Runner wiring (`--board evalplus`) shares the
 * humaneval workspace branch; scoreboard display lands at regen time.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runPythonCode } from './run-python'
import type { PublicBenchAdapter, PublicProblem } from './types'
import { HUMANEVAL_SOLUTION_FILE } from './humaneval'

export interface EvalPlusRow {
  task_id: string
  prompt: string
  canonical_solution: string
  test: string
  entry_point: string
  /** MBPP+ rows (test_list shape) are detected and rejected, never graded. */
  test_list?: unknown
}

export async function loadEvalPlusRows(path: string): Promise<EvalPlusRow[]> {
  const raw = await readFile(path, 'utf8')
  const rows: EvalPlusRow[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    rows.push(JSON.parse(trimmed) as EvalPlusRow)
  }
  return rows
}

export function rowToProblem(row: EvalPlusRow): PublicProblem {
  if (row.test_list !== undefined) {
    throw new Error(
      `MBPP+ row shape (${row.task_id}) is queued, not graded: EvalPlus v1 covers HumanEval+ rows only.`,
    )
  }
  return {
    id: row.task_id,
    objective: [
      'Implement the python function described below.',
      `Write the COMPLETE, self-contained function to ${HUMANEVAL_SOLUTION_FILE}`,
      '(imports allowed above it; no tests in the file).',
      'This board runs a STRENGTHENED test suite: edge cases beyond the',
      'examples must also pass — handle boundaries exactly.',
      '',
      '```python',
      row.prompt.trimEnd(),
      '```',
    ].join('\n'),
    test: row.test,
    entryPoint: row.entry_point,
  }
}

export function createEvalPlusAdapter(
  datasetPath: string = process.env.EVALPLUS_JSONL ?? '',
): PublicBenchAdapter {
  if (!datasetPath) {
    throw new Error(
      'EvalPlus dataset path required (EVALPLUS_JSONL or explicit argument).',
    )
  }
  return {
    name: 'evalplus',
    listProblems: async (limit?: number, offset?: number) =>
      (await loadEvalPlusRows(datasetPath))
        .slice(offset ?? 0, (offset ?? 0) + (limit ?? Number.POSITIVE_INFINITY))
        .map(rowToProblem),
    grade: async (workspace, problem) => {
      const file = join(workspace, HUMANEVAL_SOLUTION_FILE)
      let candidate: string
      try {
        candidate = await readFile(file, 'utf8')
      } catch {
        return {
          problemId: problem.id,
          passed: false,
          detail: `${HUMANEVAL_SOLUTION_FILE} not found in workspace`,
        }
      }
      const code = [
        candidate.trimEnd(),
        '',
        problem.test.trimEnd(),
        '',
        `check(${problem.entryPoint})`,
        '',
      ].join('\n')
      const run = await runPythonCode(code)
      return {
        problemId: problem.id,
        passed: run.exitCode === 0,
        detail: run.exitCode === 0 ? 'EvalPlus strengthened asserts passed' : run.outputTail,
      }
    },
  }
}
