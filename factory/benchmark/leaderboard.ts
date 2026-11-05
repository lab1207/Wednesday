// Model leaderboard - same fixture, same factory, different models,
// scores side by side. This is the equivalence instrument: a small model
// through the Factory is "frontier-grade" exactly when its row matches
// the frontier model's row on the same fixture.
//
// Run: npx tsx factory/benchmark/leaderboard.ts [--home <dir>]
// Scans <home>/<fixture>/<runId>/evidence.json (default
// WEDNESDAY_BENCHMARK_HOME or ~/.wednesday/benchmarks), prints a markdown
// table grouped by fixture plus the best run per (fixture, model).
// Offline-safe: pure reader, never calls a model.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface LeaderboardRow {
  fixture: string
  runId: string
  executionMode: string
  models: string
  status: string
  passed: number
  total: number
  repairs: number
  tokens: number
  durationMin: number
  reviewer: string | null
}

function option(
  args: string[],
  name: string,
): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  return args[index + 1]
}

export function defaultBenchmarkHome(): string {
  return (
    process.env.WEDNESDAY_BENCHMARK_HOME ??
    join(homedir(), '.wednesday', 'benchmarks')
  )
}

async function readJson(
  path: string,
): Promise<unknown | undefined> {
  try {
    return JSON.parse(
      await readFile(path, 'utf8'),
    ) as unknown
  } catch {
    return undefined
  }
}

export async function collectLeaderboard(
  home: string,
): Promise<LeaderboardRow[]> {
  const rows: LeaderboardRow[] = []
  let fixtures: string[] = []

  try {
    fixtures = await readdir(home)
  } catch {
    return rows
  }

  for (const fixture of fixtures.sort()) {
    let runs: string[] = []

    try {
      runs = await readdir(
        join(home, fixture),
      )
    } catch {
      continue
    }

    for (const runId of runs.sort()) {
      const evidence = (await readJson(
        join(home, fixture, runId, 'evidence.json'),
      )) as Record<string, any> | undefined

      if (!evidence) continue

      const acceptanceRaw: unknown =
        evidence.acceptance

      const checks: Array<{
        passed?: boolean
      }> = Array.isArray(
        acceptanceRaw,
      )
        ? acceptanceRaw
        : Array.isArray(
            (
              acceptanceRaw as {
                checks?: unknown
              } | null
            )?.checks,
          )
          ? (
              acceptanceRaw as {
                checks: Array<{
                  passed?: boolean
                }>
              }
            ).checks
          : []

      const models: Array<{
        provider?: string
        model?: string
      }> = (
        Array.isArray(
          evidence.usage?.models,
        )
          ? evidence.usage.models
          : []
      ).map(
        (
          m: unknown,
        ): {
          provider?: string
          model?: string
        } => {
          const record =
            (m as Record<
              string,
              unknown
            >) ?? {}
          // Trim: the trailing-space era (2026-09-20) recorded
          // 'model ' keys - normalize so history groups correctly.
          return {
            provider:
              typeof record.provider ===
              'string'
                ? record.provider.trim()
                : undefined,
            model:
              typeof record.model ===
              'string'
                ? record.model.trim()
                : undefined,
          }
        },
      )

      const mode: string =
        evidence.benchmark
          ?.executionMode ?? '?'

      let modelsLabel: string

      if (models.length > 0) {
        modelsLabel = models
          .map(
            m =>
              `${m.provider ?? '?'}:${m.model ?? '?'}`,
          )
          .join(',')
      } else if (mode === 'live') {
        modelsLabel =
          'live:unrecorded'
      } else {
        modelsLabel = 'deterministic'
      }

      rows.push({
        fixture,
        runId,
        executionMode: mode,
        models: modelsLabel,
        status:
          evidence.result?.status ??
          '?',
        passed: checks.filter(
          c => c.passed === true,
        ).length,
        total: checks.length,
        repairs:
          evidence.events
            ?.repairAttempts ?? 0,
        tokens:
          evidence.usage?.totalTokens ??
          0,
        durationMin: Math.round(
          (evidence.benchmark
            ?.durationMs ?? 0) / 60000,
        ),
        reviewer:
          evidence.events
            ?.reviewVerdict ?? null,
      })
    }
  }

  return rows
}

function score(row: LeaderboardRow): number {
  return row.total > 0
    ? row.passed / row.total
    : 0
}

export function renderLeaderboard(
  rows: LeaderboardRow[],
): string {
  const lines: string[] = [
    '# Model leaderboard (factory equivalence)',
    '',
    '| Fixture | Run | Mode | Model | Result | Score | Repairs | Tokens | Min | Reviewer |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ]

  for (const row of rows) {
    lines.push(
      `| ${row.fixture} | ${row.runId} | ${row.executionMode} | ${row.models} | ${row.status} | ${row.passed}/${row.total} | ${row.repairs} | ${row.tokens} | ${row.durationMin} | ${row.reviewer ?? '-'} |`,
    )
  }

  // Best run per (fixture, model): highest score, then fewest repairs.
  const best = new Map<string, LeaderboardRow>()

  for (const row of rows) {
    const key = `${row.fixture}\u0000${row.models}`
    const current = best.get(key)

    if (
      !current ||
      score(row) > score(current) ||
      (score(row) ===
        score(current) &&
        row.repairs < current.repairs)
    ) {
      best.set(key, row)
    }
  }

  lines.push('', '## Best per (fixture, model)', '')

  for (const row of [...best.values()].sort(
    (a, b) =>
      a.fixture.localeCompare(
        b.fixture,
      ) ||
      a.models.localeCompare(b.models),
  )) {
    lines.push(
      `- ${row.fixture} / ${row.models}: **${row.passed}/${row.total}** (${row.runId}, ${row.repairs} repairs, ${row.tokens} tokens)`,
    )
  }

  return lines.join('\n')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const home =
    option(args, '--home') ??
    defaultBenchmarkHome()

  const rows =
    await collectLeaderboard(home)

  console.log(renderLeaderboard(rows))
}

const isMain =
  process.argv[1] !== undefined &&
  process.argv[1].endsWith(
    'leaderboard.ts',
  )

if (isMain) {
  void main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
