/**
 * SWE-bench Verified adapter — Tier-1 board (gold standard, 500 human-
 * verified instances).
 *
 * Verified ships the same instance family as Lite (SWE-bench/SWE-bench_Verified
 * on HuggingFace) but in UPSTREAM field shape: FAIL_TO_PASS / PASS_TO_PASS
 * (upper-case) plus a `patch` (gold) field the model must never see. This
 * module normalizes upstream rows into the shared SweRow shape (lower-case
 * test lists, gold patch STRIPPED at load — same anti-leakage rule as Lite)
 * and reuses the Lite workspace + pytest machinery verbatim (clone mirror
 * at base_commit, apply test_patch, FAIL_TO_PASS + PASS_TO_PASS, revert
 * test files). Verified spans more repos than Lite, so its mirror set is
 * bigger — mirrors are fetched at setup under the same SWEBENCH_REPOS_ROOT.
 *
 * Dataset: Verified JSONL cached at setup WITHOUT gold (`patch` dropped on
 * load AND must already be absent on disk — load asserts it). Runner wiring
 * (`--board swebench-verified`, SWEBENCH_VERIFIED_JSONL) shares the swebench
 * workspace branch; scoreboard display lands at regen time.
 */

import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import type { PublicBenchAdapter, PublicProblem } from './types'
import {
  createSweBenchAdapter,
  rowToProblem as liteRowToProblem,
  type SweRow,
} from './swebench'

/** Upstream HuggingFace row shape for SWE-bench Verified. */
export interface VerifiedUpstreamRow {
  instance_id: string
  repo: string
  base_commit: string
  environment_setup_commit?: string
  version?: string
  problem_statement: string
  hints_text?: string
  test_patch: string
  FAIL_TO_PASS: string[]
  PASS_TO_PASS: string[]
  /** Gold patch — must never reach the model or the workspace. */
  patch?: string
}

/**
 * Normalize one upstream row: upper-case test lists → shared shape, gold
 * patch dropped. Throws when test lists are missing (a row that cannot be
 * graded must fail loudly, never silently pass).
 */
export function normalizeVerifiedRow(row: VerifiedUpstreamRow): SweRow {
  if (!Array.isArray(row.FAIL_TO_PASS) || !Array.isArray(row.PASS_TO_PASS)) {
    throw new Error(
      `Verified row ${row.instance_id ?? '(unknown)'} lacks FAIL_TO_PASS/PASS_TO_PASS — ungradable.`,
    )
  }
  return {
    instance_id: row.instance_id,
    repo: row.repo,
    base_commit: row.base_commit,
    environment_setup_commit: row.environment_setup_commit ?? '',
    version: String(row.version ?? ''),
    problem_statement: row.problem_statement,
    hints_text: row.hints_text ?? '',
    test_patch: row.test_patch,
    fail_to_pass: row.FAIL_TO_PASS,
    pass_to_pass: row.PASS_TO_PASS,
  }
}

export async function loadVerifiedRows(
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
    const raw = JSON.parse(trimmed) as VerifiedUpstreamRow & { patch?: string; fail_to_pass?: unknown }
    if (typeof raw.patch === 'string' && raw.patch.length > 0) {
      throw new Error(
        `Verified dataset leaks gold (instance ${raw.instance_id}): strip 'patch' at fetch time.`,
      )
    }
    if (skipped < offset) {
      skipped += 1
      continue
    }
    rows.push(normalizeVerifiedRow(raw))
    if (rows.length >= limit) break
  }
  return rows
}

export function verifiedRowToProblem(row: SweRow): PublicProblem {
  const lite = liteRowToProblem(row)
  return { ...lite, id: `swe-verified/${row.instance_id}` }
}

export function createSweVerifiedAdapter(
  datasetPath: string = process.env.SWEBENCH_VERIFIED_JSONL ?? '',
): PublicBenchAdapter {
  if (!datasetPath) {
    throw new Error(
      'SWE-bench Verified dataset path required (SWEBENCH_VERIFIED_JSONL or explicit argument).',
    )
  }
  const lite = createSweBenchAdapter(datasetPath)
  // Grading is the shared pytest driver (it only reads workspace + problem,
  // never the dataset); only listing differs (Verified normalization + id
  // prefix). Delegate rather than duplicate.
  return {
    name: 'swebench-verified',
    listProblems: async (limit?: number, offset?: number) =>
      (await loadVerifiedRows(datasetPath, limit, offset)).map(verifiedRowToProblem),
    grade: (workspace, problem) => lite.grade(workspace, problem),
  }
}
