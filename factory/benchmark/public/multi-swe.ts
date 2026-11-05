/**
 * Multi-SWE-bench adapter — rust slice v1 (Tier-2 board).
 *
 * Multi-SWE-bench (multi-swe-bench/multi-swe-bench, Apache-2.0, ByteDance
 * Seed, NeurIPS 2025): 7+ languages, no Python. v1 covers the RUST slice
 * only (10 repos; our toolchain is python+rust, and rust builds on the
 * host cargo) — other languages need their toolchains first (queued, same
 * precedent as the aider python+rust slice). HF dataset
 * ByteDance-Seed/Multi-SWE-bench, per-language JSONL
 * (`<lang>/<org>__<repo>_dataset.jsonl`).
 *
 * Row shape (rust): {instance_id, org, repo, base{sha}, title, body,
 * test_patch, fix_patch (GOLD — stripped), f2p_tests/p2p_tests as
 * {name: {run/test/fix}} maps}. Grading mirrors the SWE family: clone the
 * mirror at base.sha, `git apply` the test_patch, `cargo test` the F2P+P2P
 * name filters, revert ONLY test-patch files after. Documented deviation:
 * host cargo instead of upstream Docker images (same tests, different
 * env); old repos may need pinned toolchains at fetch time (rustup), and
 * the host needs a system linker (MSVC link.exe on Windows, cc on unix).
 *
 * Dataset: rust JSONL converted WITHOUT gold at fetch time
 * (`MULTISWE_JSONL` env or argument). Runner wiring (`--board
 * multi-swe`) shares a rust workspace branch; scoreboard display at regen.
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PublicBenchAdapter, PublicProblem } from './types'

const execFileAsync = promisify(execFile)

export const MULTISWE_GRADE_FILE = 'grade_multiswe.py'

export interface MultiSweUpstreamRow {
  instance_id: string
  org: string
  repo: string
  base: { sha: string }
  title: string
  body: string
  test_patch: string
  f2p_tests: Record<string, unknown>
  p2p_tests: Record<string, unknown>
  /** Gold patch + recorded outcomes — must never reach the model. */
  fix_patch?: string
}

export interface MultiSweRow {
  instance_id: string
  repo: string
  base_commit: string
  problem_statement: string
  test_patch: string
  fail_to_pass: string[]
  pass_to_pass: string[]
}

/** Normalize one upstream row: test-name maps → lists, gold dropped. */
export function normalizeMultiSweRow(row: MultiSweUpstreamRow): MultiSweRow {
  if (typeof row.f2p_tests !== 'object' || row.f2p_tests === null) {
    throw new Error(`Multi-SWE row ${row.instance_id ?? '(unknown)'} lacks f2p_tests — ungradable.`)
  }
  return {
    instance_id: row.instance_id,
    repo: `${row.org}/${row.repo}`,
    base_commit: row.base?.sha ?? '',
    problem_statement: `# ${row.title}\n\n${row.body}`,
    test_patch: row.test_patch,
    fail_to_pass: Object.keys(row.f2p_tests),
    pass_to_pass: Object.keys(row.p2p_tests ?? {}),
  }
}

export async function loadMultiSweRows(
  path: string,
  limit = Number.POSITIVE_INFINITY,
  offset = 0,
): Promise<MultiSweRow[]> {
  const rows: MultiSweRow[] = []
  let skipped = 0
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const raw = JSON.parse(trimmed) as MultiSweUpstreamRow
    if (typeof raw.fix_patch === 'string' && raw.fix_patch.length > 0) {
      throw new Error(
        `Multi-SWE dataset leaks gold (instance ${raw.instance_id}): strip 'fix_patch' at fetch time.`,
      )
    }
    if (skipped < offset) {
      skipped += 1
      continue
    }
    rows.push(normalizeMultiSweRow(raw))
    if (rows.length >= limit) break
  }
  return rows
}

export function multiSweRowToProblem(row: MultiSweRow): PublicProblem {
  return {
    id: `multi-swe/${row.instance_id}`,
    objective: [
      `Fix the GitHub issue below in the ${row.repo} checkout (already at the base commit).`,
      'Edit the SOURCE files that cause the bug. Do not edit test files.',
      'Hidden tests will be applied at grade time; fix the root cause, not the symptoms.',
      '',
      row.problem_statement.trimEnd(),
    ].join('\n'),
    test: JSON.stringify(row),
    entryPoint: row.instance_id,
  }
}

/** Test-file paths touched by a unified diff (`+++ b/<path>` lines). */
export function multiSweTestFiles(testPatch: string): string[] {
  const out: string[] = []
  for (const line of testPatch.split('\n')) {
    const m = /^\+{3} b\/(.+)\s*$/.exec(line.trimEnd())
    if (m) out.push(m[1])
  }
  return out
}

/**
 * Grader driver: applies the hidden test patch, runs `cargo test` over the
 * F2P+P2P name filters, reverts only the test-patch files, exits 0 iff
 * cargo passes. `cargo test -- <filter>` matches test-name substrings, so
 * fully-qualified names work as filters.
 */
export function multiSweGraderSeed(problem: PublicProblem): string {
  const row = JSON.parse(problem.test) as MultiSweRow
  const tests = [...row.fail_to_pass, ...row.pass_to_pass]
  return [
    '"""Official board grader (generated by multi-swe adapter). DO NOT MODIFY."""',
    'import subprocess, sys',
    '',
    'test_files = ' + JSON.stringify(multiSweTestFiles(row.test_patch)),
    'test_names = ' + JSON.stringify(tests),
    '',
    'with open("test_multiswe.patch", "w") as fh:',
    '    fh.write(' + JSON.stringify(row.test_patch) + ')',
    '',
    'apply = subprocess.run(["git", "apply", "test_multiswe.patch"], capture_output=True, text=True)',
    'if apply.returncode != 0:',
    '    print("TEST_PATCH_APPLY_FAILED"); print(apply.stderr[-2000:]); sys.exit(2)',
    '',
    'run = subprocess.run(["cargo", "test", "--quiet", "--"] + test_names, capture_output=True, text=True)',
    'print((run.stdout + run.stderr)[-4000:])',
    'code = run.returncode',
    '',
    'revert = subprocess.run(["git", "checkout", "--"] + test_files, capture_output=True, text=True)',
    'clean = subprocess.run(["git", "clean", "-f", "--"] + test_files, capture_output=True, text=True)',
    'if revert.returncode != 0 and clean.returncode != 0:',
    '    print("TEST_REVERT_FAILED"); sys.exit(3)',
    '',
    'sys.exit(0 if code == 0 else 1)',
    '',
  ].join('\n')
}

async function git(workspace: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: workspace, timeout: 300_000 })
}

export async function setupMultiSweWorkspace(
  workspace: string,
  problem: PublicProblem,
  reposRoot: string = process.env.MULTISWE_REPOS_ROOT ?? '',
): Promise<void> {
  if (!reposRoot) {
    throw new Error('Multi-SWE repos mirror root required (MULTISWE_REPOS_ROOT or explicit argument).')
  }
  const row = JSON.parse(problem.test) as MultiSweRow
  await mkdir(join(workspace, '..'), { recursive: true }).catch(() => undefined)
  await execFileAsync(
    'git', ['clone', join(reposRoot, row.repo.replace('/', '__')), workspace], { timeout: 600_000 },
  )
  await git(workspace, 'checkout', row.base_commit)
  await writeFile(join(workspace, MULTISWE_GRADE_FILE), multiSweGraderSeed(problem), 'utf8')
}

export function createMultiSweAdapter(
  datasetPath: string = process.env.MULTISWE_JSONL ?? '',
): PublicBenchAdapter {
  if (!datasetPath) {
    throw new Error(
      'Multi-SWE dataset path required (MULTISWE_JSONL or explicit argument).',
    )
  }
  return {
    name: 'multi-swe',
    listProblems: async (limit?: number, offset?: number) =>
      (await loadMultiSweRows(datasetPath, limit, offset)).map(multiSweRowToProblem),
    grade: async (workspace, problem) => {
      try {
        const { pythonBin } = await import('./run-python')
        await execFileAsync(
          pythonBin(),
          [MULTISWE_GRADE_FILE],
          { cwd: workspace, timeout: 900_000, windowsHide: true },
        )
        return { problemId: problem.id, passed: true, detail: 'board tests passed' }
      } catch (err: unknown) {
        const out =
          err instanceof Error ? (err as Error & { stdout?: string }).stdout ?? String(err) : String(err)
        return { problemId: problem.id, passed: false, detail: String(out).slice(-800) }
      }
    },
  }
}
