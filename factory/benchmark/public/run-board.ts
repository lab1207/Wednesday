import { homedir } from 'node:os'
import { join } from 'node:path'

import { loadConfig, requireLiveConfig } from '../../harness/config'

/**
 * Public-board runner CLI (humaneval, aider, livecodebench, swebench, evalplus, swebench-verified, swebench-live, multi-swe wired).
 *
 *   npx tsx factory/benchmark/public/run-board.ts --mode live --limit 10
 *   npx tsx factory/benchmark/public/run-board.ts --board aider --mode live --limit 5
 *   npx tsx factory/benchmark/public/run-board.ts --board livecodebench --mode live --limit 5
 *   npx tsx factory/benchmark/public/run-board.ts --board swebench --mode live --limit 5
 *   npx tsx factory/benchmark/public/run-board.ts --board evalplus --mode live --limit 5
 *   npx tsx factory/benchmark/public/run-board.ts --board humaneval --mode live --limit 5 --samples 3
 *
 * --samples K runs K independent attempts per problem (pass@k); the problem
 * passes when ANY sample passes, stopping early on the first pass.
 *
 * --ablation ALSO runs the bare model on the same problems, with no factory
 * around it, so the board can say what the factory ADDS (the solo pass rate
 * beside the factory pass rate). It doubles the batch's spend, so it is
 * opt-in. Boards that grade a repository fix (swebench*, multi-swe) cannot
 * carry the bare arm and report that honestly instead of a fake zero.
 *
 *   npx tsx factory/benchmark/public/run-board.ts --mode live --limit 10
 *   npx tsx factory/benchmark/public/run-board.ts --board humaneval --mode live --limit 5 --ablation
 *
 * Deterministic mode (default) proves the loop plumbing offline with the
 * recording coder (expected red). Live mode runs the configured model
 * (Colab small model via LOCAL_TOOL_PROXY_UPSTREAM / OpenRouter) — keys
 * load from ~/.wednesday/.env only; nothing enters chat or the repo.
 */

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  return args[index + 1]
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Credentials/env must be loaded BEFORE the store/paths/service modules
  // load (same ordering rule as run-benchmark.ts) — hence the dynamic import.
  await loadConfig()

  const board = (option(args, '--board') ?? 'humaneval').trim().toLowerCase()
  const datasetPath = option(args, '--dataset')
    ?? (board === 'aider'
      ? process.env.POLYGLOT_ROOT ?? ''
      : board === 'livecodebench'
        ? process.env.LIVECODEBENCH_JSONL ?? ''
        : board === 'swebench'
          ? process.env.SWEBENCH_JSONL ?? ''
          : board === 'swebench-verified'
            ? process.env.SWEBENCH_VERIFIED_JSONL ?? ''
            : board === 'swebench-live'
              ? process.env.SWEBENCH_LIVE_JSONL ?? ''
              : board === 'multi-swe'
                ? process.env.MULTISWE_JSONL ?? ''
                : board === 'evalplus'
            ? process.env.EVALPLUS_JSONL ?? ''
            : process.env.HUMANEVAL_JSONL ?? '')
  const mode = (option(args, '--mode') ?? process.env.FACTORY_EXECUTION_MODE ?? 'deterministic')
    .trim()
    .toLowerCase()
  const outRoot = option(args, '--out')
    ?? process.env.WEDNESDAY_BENCHMARK_HOME
    ?? join(homedir(), '.wednesday', 'benchmarks', 'public')
  const limit = Number(option(args, '--limit') ?? 5)
  const offset = Number(option(args, '--offset') ?? 0)
  const samples = Number(option(args, '--samples') ?? 1)
  // Team or solo from the CLI (2026-10-13): --solo forces one model per
  // problem, --team forces the pool duel (--lanes sets the width).
  // Flags win for this run only; profile env applies when absent.
  if (args.includes('--solo')) process.env.FACTORY_EXPANSION = 'solo'
  else if (args.includes('--team')) process.env.FACTORY_EXPANSION = 'duel'
  const lanes = option(args, '--lanes')
  if (lanes !== undefined) process.env.FACTORY_DUEL_WIDTH = lanes

  if (board !== 'humaneval' && board !== 'aider' && board !== 'livecodebench' && board !== 'swebench' && board !== 'evalplus' && board !== 'swebench-verified' && board !== 'swebench-live' && board !== 'multi-swe') {
    throw new Error(`Unsupported --board: ${board} (wired: humaneval, aider, livecodebench, swebench, evalplus, swebench-verified, swebench-live, multi-swe).`)
  }
  if (!datasetPath) {
    throw new Error('Missing dataset: pass --dataset or set HUMANEVAL_JSONL.')
  }
  if (mode !== 'deterministic' && mode !== 'live') {
    throw new Error(`Invalid --mode: ${mode} (expected deterministic or live).`)
  }
  if (mode === 'live') {
    // Throws with guidance when key/model are missing — a missing credential
    // must never produce a silently-failed board run.
    requireLiveConfig()
    // Layer audit 2026-09-21: print the resolved route (the first live
    // smoke burned on a stale profile provider) and fail fast when the
    // local route is unreachable — not per problem, minutes later.
    const provider = (process.env.FACTORY_LLM_PROVIDER ?? 'openrouter').trim().toLowerCase() || 'openrouter'
    const baseURL = (process.env.LOCAL_LLM_BASE_URL ?? '').trim()
    console.log(JSON.stringify({
      liveRoute: provider,
      localBaseUrl: provider === 'local' ? baseURL || '(default)' : '(n/a)',
    }))
    if (provider === 'local') {
      const { checkLocalUpstream } = await import('../../model-router/providers/local')
      const health = await checkLocalUpstream()
      console.log(JSON.stringify({ localUpstream: health }))
      if (!health.ok) {
        throw new Error(
          `Local model route unreachable: ${health.error} — start the proxy/Colab tunnel first, then re-run.`,
        )
      }
    }
  }
  process.env.FACTORY_EXECUTION_MODE = mode

  const { runBoard } = await import('./board-runner')
  const summary = await runBoard({
    board: board as 'humaneval' | 'aider' | 'livecodebench' | 'swebench' | 'evalplus' | 'swebench-verified' | 'swebench-live' | 'multi-swe',
    datasetPath,
    mode: mode as 'deterministic' | 'live',
    outRoot,
    limit,
    offset,
    samples,
    // THE ABLATION ARM (2026-11-05): `--ablation` also runs the BARE model
    // on the same problems with no factory around it, so the board can say
    // what the factory ADDS. Without the flag the arm does not run and the
    // summary says nothing about it - an arm that always ran would double
    // every batch's spend without being asked.
    ablation: args.includes('--ablation'),
  })

  console.log(JSON.stringify({
    ok: true,
    board: summary.board,
    mode: summary.mode,
    total: summary.total,
    passed: summary.passed,
    passRate: summary.passRate,
    totalTokens: summary.totalTokens,
    durationMs: summary.durationMs,
    batchDir: summary.batchDir,
    // The ablation summary is null when the arm did not run (or the board
    // cannot support it) - never a fake zero.
    ablation: summary.ablation ?? null,
  }, null, 2))
}

void main().catch((error: unknown) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2))
  process.exitCode = 1
}).finally(() => {
  // The cordis Context created inside the service keeps the event loop
  // alive; exit explicitly at the CLI boundary.
  process.exit(process.exitCode ?? 0)
})
