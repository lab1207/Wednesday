/**
 * HumanEval adapter — board 1 of the public-benchmark ladder (smoke test).
 *
 * HumanEval (OpenAI, MIT): 164 python function-completion problems, graded
 * by running the board's own `check(candidate)` asserts against the
 * candidate. Published pass@1 numbers exist for most big models, so the
 * board gives a clean end-to-end check of the public-bench plumbing even
 * though it is saturated as a headline.
 *
 * Coder contract: write the completed function to `solution.py`, self
 * contained (imports + the full function from the board prompt). Grading
 * concatenates the file with the board test and calls `check(entry_point)`;
 * exit 0 = pass. Dataset: JSONL rows of
 * {task_id, prompt, canonical_solution, test, entry_point} — fetched at
 * live setup into a gitignored path (`HUMANEVAL_JSONL` env or argument).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runPythonCode } from './run-python'
import type { PublicBenchAdapter, PublicProblem } from './types'

export interface HumanEvalRow {
  task_id: string
  prompt: string
  canonical_solution: string
  test: string
  entry_point: string
}

export const HUMANEVAL_SOLUTION_FILE = 'solution.py'

export async function loadHumanEvalRows(path: string): Promise<HumanEvalRow[]> {
  const raw = await readFile(path, 'utf8')
  const rows: HumanEvalRow[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    rows.push(JSON.parse(trimmed) as HumanEvalRow)
  }
  return rows
}

export function rowToProblem(row: HumanEvalRow): PublicProblem {
  return {
    id: row.task_id,
    objective: [
      'Implement the python function described below.',
      `Write the COMPLETE, self-contained function to ${HUMANEVAL_SOLUTION_FILE}`,
      '(imports allowed above it; no tests in the file).',
      '',
      '```python',
      row.prompt.trimEnd(),
      '```',
    ].join('\n'),
    test: row.test,
    entryPoint: row.entry_point,
  }
}

export function createHumanEvalAdapter(
  datasetPath: string = process.env.HUMANEVAL_JSONL ?? '',
): PublicBenchAdapter {
  if (!datasetPath) {
    throw new Error(
      'HumanEval dataset path required (HUMANEVAL_JSONL or explicit argument).',
    )
  }
  return {
    name: 'humaneval',
    listProblems: async (limit?: number, offset?: number) =>
      (await loadHumanEvalRows(datasetPath))
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
        detail: run.exitCode === 0 ? 'board asserts passed' : run.outputTail,
      }
    },
  }
}
