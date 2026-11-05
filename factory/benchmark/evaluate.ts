import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { BenchmarkEvidence } from './types'

/**
 * V1.6 benchmark evaluator.
 *
 * Lists every recorded benchmark run under the output root and prints a
 * comparison table so the same task/starting repository can be compared
 * across model/provider revisions (roadmap §9 "Benchmark rule").
 *
 *   npx tsx factory/benchmark/evaluate.ts [--fixture snippetbox] [--out <dir>]
 */

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  return args[index + 1]
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const outRoot = option(args, '--out') ?? process.env.WEDNESDAY_BENCHMARK_HOME ?? join(homedir(), '.wednesday', 'benchmarks')
  const fixtureFilter = option(args, '--fixture')

  let fixtureNames: string[]
  try {
    fixtureNames = (await readdir(outRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => fixtureFilter === undefined || name === fixtureFilter)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'ENOENT') {
      console.log(`No benchmark evidence found under ${outRoot} (directory does not exist).`)
      process.exit(0)
    }
    throw error
  }

  const rows: Array<{ evidence: BenchmarkEvidence; runDir: string }> = []
  for (const fixture of fixtureNames) {
    const fixturesRoot = join(outRoot, fixture)
    const entries = await readdir(fixturesRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const runDir = join(fixturesRoot, entry.name)
      try {
        const raw = await readFile(join(runDir, 'evidence.json'), 'utf8')
        rows.push({ evidence: JSON.parse(raw) as BenchmarkEvidence, runDir })
      } catch {
        // Not a benchmark run directory (missing or invalid evidence.json).
      }
    }
  }

  rows.sort((a, b) => a.evidence.benchmark.startedAt.localeCompare(b.evidence.benchmark.startedAt))

  if (rows.length === 0) {
    console.log(`No benchmark evidence found under ${outRoot} (fixture filter: ${fixtureFilter ?? 'all'}).`)
    process.exit(0)
  }

  const header = [
    pad('runId', 22),
    pad('fixture', 12),
    pad('mode', 13),
    pad('status', 9),
    pad('hermes', 9),
    pad('dur(s)', 8),
    pad('acceptance', 11),
    pad('tests', 6),
    pad('booted', 7),
    pad('repairs', 8),
    pad('files', 6),
    pad('tokens', 7),
    pad('cost$', 8),
  ]
  console.log(header.join(' '))
  console.log('-'.repeat(header.join(' ').length))

  for (const { evidence, runDir } of rows) {
    const b = evidence.benchmark
    const acceptance = `${evidence.acceptance.checks.filter(check => check.passed).length}/${evidence.acceptance.checks.length}`
    const tests = evidence.regressions.passed ? 'PASS' : 'FAIL'
    console.log([
      pad(b.runId, 22),
      pad(b.fixture, 12),
      pad(b.executionMode, 13),
      pad(evidence.result.status, 9),
      pad(evidence.run.hermesStatus, 9),
      pad((b.durationMs / 1000).toFixed(1), 8),
      pad(acceptance, 11),
      pad(tests, 6),
      pad(String(evidence.deployment.booted), 7),
      pad(String(evidence.events.repairAttempts), 8),
      pad(String(evidence.result.filesChanged.length), 6),
      pad(String(evidence.usage.totalTokens), 7),
      pad(evidence.usage.costUsd === null ? 'n/a' : evidence.usage.costUsd.toFixed(4), 8),
    ].join(' '))
  }

  console.log('')
  console.log(`Runs: ${rows.length}`)
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})