// Leaderboard test - scoring and comparison over fabricated evidence.
//
// Run: npx tsx factory/benchmark/leaderboard-test.ts
//
// Proves (offline, no models, temp home):
// 1. collectLeaderboard reads every run's evidence.json.
// 2. Scores count passed checks (array AND {checks} shapes).
// 3. Best-per-(fixture,model) picks highest score, then fewest repairs.
// 4. Model ids normalize (trailing-space era groups with clean ids).

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  collectLeaderboard,
  renderLeaderboard,
} from './leaderboard'

function evidence(options: {
  mode: string
  status: string
  passed: boolean[]
  repairs: number
  tokens: number
  models: Array<{
    provider: string
    model: string
  }>
  reviewer?: string | null
}): unknown {
  return {
    benchmark: {
      executionMode: options.mode,
      durationMs: 60000,
    },
    result: { status: options.status },
    acceptance: {
      checks: options.passed.map(
        (passed, index) => ({
          criterion: `check ${index}`,
          passed,
          details: '',
        }),
      ),
    },
    events: {
      repairAttempts: options.repairs,
      reviewVerdict:
        options.reviewer ?? null,
    },
    usage: {
      totalTokens: options.tokens,
      models: options.models.map(m => ({
        ...m,
        calls: 1,
        promptTokens: 1,
        completionTokens: 1,
      })),
    },
  }
}

async function main(): Promise<void> {
  const home = await mkdtemp(
    join(tmpdir(), 'leaderboard-'),
  )

  try {
    const runs: Array<{
      fixture: string
      runId: string
      evidence: unknown
    }> = [
      {
        fixture: 'demo',
        runId: 'run-small-a',
        evidence: evidence({
          mode: 'live',
          status: 'failed',
          passed: [true, true, false],
          repairs: 2,
          tokens: 100,
          models: [
            {
              provider: 'local',
              model: 'tiny-3b',
            },
          ],
        }),
      },
      {
        fixture: 'demo',
        runId: 'run-small-b',
        evidence: evidence({
          mode: 'live',
          status: 'completed',
          passed: [true, true, true],
          repairs: 5,
          tokens: 300,
          // Trailing-space era id must group with the clean one.
          models: [
            {
              provider: 'local',
              model: 'tiny-3b ',
            },
          ],
          reviewer: 'pass',
        }),
      },
      {
        fixture: 'demo',
        runId: 'run-big',
        evidence: evidence({
          mode: 'live',
          status: 'completed',
          passed: [true, true, true],
          repairs: 0,
          tokens: 900,
          models: [
            {
              provider: 'openrouter',
              model: 'giant-100b',
            },
          ],
          reviewer: 'pass',
        }),
      },
    ]

    for (const run of runs) {
      const dir = join(
        home,
        run.fixture,
        run.runId,
      )
      await mkdir(dir, {
        recursive: true,
      })
      await writeFile(
        join(dir, 'evidence.json'),
        JSON.stringify(run.evidence),
        'utf8',
      )
    }

    const rows =
      await collectLeaderboard(home)

    // 1 + 2. Every run read, {checks} shape scored.
    assert.equal(rows.length, 3)
    const byId = new Map(
      rows.map(row => [row.runId, row]),
    )
    assert.equal(
      byId.get('run-small-a')?.passed,
      2,
    )
    assert.equal(
      byId.get('run-small-a')?.total,
      3,
    )
    assert.equal(
      byId.get('run-small-b')?.repairs,
      5,
    )
    assert.equal(
      byId.get('run-big')?.reviewer,
      'pass',
    )

    const text = renderLeaderboard(rows)

    // 3. Best picks: tiny-3b run-small-b (3/3 beats 2/3), giant run-big.
    assert.ok(
      text.includes(
        'demo / local:tiny-3b: **3/3** (run-small-b, 5 repairs, 300 tokens)',
      ),
    )
    assert.ok(
      text.includes(
        'demo / openrouter:giant-100b: **3/3** (run-big, 0 repairs, 900 tokens)',
      ),
    )
    // 4. No split group for the trailing-space id.
    assert.ok(
      !text.includes('tiny-3b :'),
      'trailing-space model ids must normalize',
    )

    console.log(
      'LEADERBOARD TEST: PASS (scored 3 runs, best-picks + normalization)',
    )
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
