/**
 * SWE-bench-Live adapter — Python split (continuously refreshed).
 *
 * SWE-bench-Live/SWE-bench-Live on HuggingFace (MIT, Microsoft): same
 * instance family as Lite/Verified (instance_id, repo, base_commit,
 * problem_statement, hints_text, test_patch, FAIL_TO_PASS, PASS_TO_PASS)
 * plus `test_cmds`, `log_parser` and difficulty stats — and the same
 * `patch` (gold) field the model must never see. Splits: test 1000 /
 * lite 300 (frozen) / verified 500 (frozen) / full 1888+ (grows ~50
 * issues/month). MultiLang/Windows splits are container-per-language and
 * stay Docker-gated; THIS adapter covers the Python split only, reusing
 * the shared host-pytest driver (same documented deviation as Lite:
 * local checkout + pytest instead of upstream containers; grade runs
 * AFTER rollout, so the no-tests-during-rollout protocol holds).
 *
 * Dataset: parquet upstream → JSONL converted WITHOUT gold at fetch time
 * (`SWEBENCH_LIVE_JSONL` env or argument). Runner wiring (`--board
 * swebench-live`) shares the swebench workspace branch; scoreboard
 * display lands at regen time.
 */

import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import type { PublicBenchAdapter, PublicProblem } from './types'
import {
  createSweBenchAdapter,
  rowToProblem as liteRowToProblem,
  type SweRow,
} from './swebench'

/** Upstream HuggingFace row shape (Python split). */
export interface LiveUpstreamRow {
  instance_id: string
  repo: string
  base_commit: string
  problem_statement: string
  hints_text?: string
  test_patch: string
  FAIL_TO_PASS: string[]
  PASS_TO_PASS: string[]
  /** Extra upstream context (recorded, not graded by us). */
  test_cmds?: string[]
  log_parser?: string
  /** Gold patch — must never reach the model or the workspace. */
  patch?: string
}

/**
 * Normalize one upstream row into the shared SweRow shape. Throws when
 * test lists are missing (ungradable rows fail loudly, never silently).
 */
export function normalizeLiveRow(row: LiveUpstreamRow): SweRow {
  if (!Array.isArray(row.FAIL_TO_PASS) || !Array.isArray(row.PASS_TO_PASS)) {
    throw new Error(
      `Live row ${row.instance_id ?? '(unknown)'} lacks FAIL_TO_PASS/PASS_TO_PASS — ungradable.`,
    )
  }
  return {
    instance_id: row.instance_id,
    repo: row.repo,
    base_commit: row.base_commit,
    environment_setup_commit: '',
    version: '',
    problem_statement: row.problem_statement,
    hints_text: row.hints_text ?? '',
    test_patch: row.test_patch,
    fail_to_pass: row.FAIL_TO_PASS,
    pass_to_pass: row.PASS_TO_PASS,
  }
}

export async function loadLiveRows(
  path: string,
  limit = Number.POSITIVE_INFINITY,
  offset = 0,
): Promise<SweRow[]> {
  const rows: SweRow[] = []
  let skipped = 0
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const raw = JSON.parse(trimmed) as LiveUpstreamRow
    if (typeof raw.patch === 'string' && raw.patch.length > 0) {
      throw new Error(
        `Live dataset leaks gold (instance ${raw.instance_id}): strip 'patch' at fetch time.`,
      )
    }
    if (skipped < offset) {
      skipped += 1
      continue
    }
    rows.push(normalizeLiveRow(raw))
    if (rows.length >= limit) break
  }
  return rows
}

export function liveRowToProblem(row: SweRow): PublicProblem {
  const lite = liteRowToProblem(row)
  return { ...lite, id: `swe-live/${row.instance_id}` }
}

export function createSweLiveAdapter(
  datasetPath: string = process.env.SWEBENCH_LIVE_JSONL ?? '',
): PublicBenchAdapter {
  if (!datasetPath) {
    throw new Error(
      'SWE-bench-Live dataset path required (SWEBENCH_LIVE_JSONL or explicit argument).',
    )
  }
  const lite = createSweBenchAdapter(datasetPath)
  return {
    name: 'swebench-live',
    listProblems: async (limit?: number, offset?: number) =>
      (await loadLiveRows(datasetPath, limit, offset)).map(liveRowToProblem),
    grade: (workspace, problem) => lite.grade(workspace, problem),
  }
}
