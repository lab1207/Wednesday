import { join } from 'node:path'

import { loadConfig, requireLiveConfig } from '../config'

/**
 * V1.6 benchmark runner CLI.
 *
 * Runs the production path (Hermes submit → FactoryService → orchestrator →
 * verification → review) against a fixed fixture and records evidence
 * (acceptance probes, regressions, deployment smoke, events, usage) into
 * ~/.wednesday/benchmarks/<fixture>/<runId>/.
 *
 *   npx tsx factory/benchmark/run-benchmark.ts --fixture snippetbox --mode live
 *
 * Deterministic mode (default) proves the harness plumbing offline. Live mode
 * loads credentials from ~/.wednesday/.env (created with
 * `factory/harness/harness.ts --setup` in your own terminal) — keys never
 * enter chat, arguments or the repository.
 */

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  return args[index + 1]
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Load the operator's credentials (if any) from ~/.wednesday/.env exactly
  // like the harness does: whitelisted vars only, never overwrites process env.
  await loadConfig()

  const fixture = option(args, '--fixture')
  const mode = (option(args, '--mode') ?? process.env.FACTORY_EXECUTION_MODE ?? 'deterministic')
    .trim()
    .toLowerCase()
  const outOverride = option(args, '--out')
  const taskId = option(args, '--task-id')
  const useOpenhands = !args.includes('--no-openhands')

  if (!fixture) {
    throw new Error('Missing --fixture (e.g. snippetbox or a fixture directory path).')
  }
  if (mode !== 'deterministic' && mode !== 'live') {
    throw new Error(`Invalid --mode: ${mode} (expected deterministic or live).`)
  }

  // Environment must be configured BEFORE the store/paths/service modules load.
  process.env.FACTORY_EXECUTION_MODE = mode

  if (mode === 'live') {
    // Throws with guidance if the key/model are not available, so a missing
    // credential never produces a silently-failed benchmark run.
    requireLiveConfig()
  }

  const { runBenchmark, DEFAULT_OUT_ROOT } = await import('./runner')
  const { resolveDefinition } = await import('./definitions')

  const outRoot = outOverride ?? process.env.WEDNESDAY_BENCHMARK_HOME ?? DEFAULT_OUT_ROOT
  const definition = resolveDefinition(fixture)

  const { evidence, runDir, workspace } = await runBenchmark({
    definition,
    outRoot,
    executionMode: mode,
    useOpenhands,
    taskId,
  })

  console.log(JSON.stringify({
    ok: true,
    fixture: evidence.benchmark.fixture,
    runId: evidence.benchmark.runId,
    taskId: evidence.benchmark.taskId,
    executionMode: evidence.benchmark.executionMode,
    durationMs: evidence.benchmark.durationMs,
    status: evidence.result.status,
    hermesStatus: evidence.run.hermesStatus,
    acceptance: `${evidence.acceptance.checks.filter(check => check.passed).length}/${evidence.acceptance.checks.length} passed`,
    regressionsPassed: evidence.regressions.passed,
    booted: evidence.deployment.booted,
    repairAttempts: evidence.events.repairAttempts,
    totalTokens: evidence.usage.totalTokens,
    filesChanged: evidence.result.filesChanged.length,
    runDir,
    workspace,
  }, null, 2))
}

void main().catch((error: unknown) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2))
  process.exitCode = 1
}).finally(() => {
  // CLI boundary: the benchmark leaves the event bus's file handle open, so
  // the process is ended explicitly. The SERVICE's watchers are no longer
  // part of that problem - the hermes store disposes the service it creates
  // (2026-11-07), so nothing is torn down mid-close here.
  process.exit(process.exitCode ?? 0)
})