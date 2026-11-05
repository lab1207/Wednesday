/**
 * Offline test for the published-anchors scoreboard. No network, no model:
 * asserts the official 3B rows are written down, ceilings exist, and the
 * comparison math (lift in percentage points + markdown row) is exact.
 */
import assert from 'node:assert/strict'
import {
  CEILING_ANCHORS,
  COMPARISON_HEADER,
  compareFactoryVsAnchors,
  MARKET_ANCHORS,
  QWEN_3B_OFFICIAL,
  QWEN_3B_REPRO,
  renderComparisonRow,
  renderThreeStageReport,
  runThreeStageEvaluation,
} from './anchors'

async function main(): Promise<void> {
  // 1. Official 3B HumanEval anchor matches Table 16 (84.1 HE, 80.5 HE+).
  const he = QWEN_3B_OFFICIAL.find(r => r.metric === 'HumanEval HE pass@1')
  assert.ok(he, 'missing official HumanEval HE anchor')
  assert.equal(he.score, 0.841)
  assert.ok(he.source.includes('Table 16'))

  // 2. Official 3B Aider anchor matches Table 19 (33.8 Pass@1).
  const aider = QWEN_3B_OFFICIAL.find(r => r.metric === 'Aider Pass@1')
  assert.ok(aider, 'missing official Aider anchor')
  assert.equal(aider.score, 0.338)

  // 3. Repro anchor records the harness-sensitive gap (45.12 OpenCompass).
  const repro = QWEN_3B_REPRO.find(r => r.board === 'humaneval')
  assert.ok(repro, 'missing repro anchor')
  assert.equal(repro.score, 0.4512)

  // 4. Ceilings exist per board (32B rows, never re-run).
  assert.ok(CEILING_ANCHORS.some(r => r.model.includes('32b')), 'missing 32B ceiling')
  assert.ok(CEILING_ANCHORS.some(r => r.board === 'humaneval'), 'missing humaneval ceiling')

  // 5. Comparison math: factory 60% on humaneval vs 84.1 official / 45.12 repro.
  const c = compareFactoryVsAnchors('humaneval', 0.6)
  assert.equal(c.rawOfficial, 0.841)
  assert.equal(c.repro, 0.4512)
  assert.equal(c.liftOverOfficialPp, -24.1)
  assert.equal(c.liftOverReproPp, 14.9)
  assert.ok(c.ceilings.length > 0)

  // 6. Markdown row renders the "what grade did Factory produce" line.
  const row = renderComparisonRow(c)
  assert.ok(row.includes('humaneval'))
  assert.ok(row.includes('60.0%'))
  assert.ok(row.includes('84.1%'))
  assert.ok(row.includes('45.1%'))
  assert.ok(COMPARISON_HEADER.startsWith('| Board |'))

  // 7. 3-stage pipeline: baseline -> verification -> market standing.
  assert.ok(MARKET_ANCHORS.some(r => r.board === 'humaneval' && r.model === 'qwen2.5-coder-7b-instruct'))
  const report = runThreeStageEvaluation('humaneval', 0.6)
  assert.ok(report.stage1.rows.length > 0, 'stage1 baseline empty')
  assert.equal(report.stage2.officialScore, 0.841)
  assert.equal(report.stage2.deltaOfficialPp, -24.1)
  assert.ok(report.stage2.harnessNote.includes('harness'))
  assert.ok(report.stage3.rank >= 1 && report.stage3.rank <= report.stage3.total)
  assert.ok(report.stage3.ranked.some(r => r.model.includes('factory')))
  const md = renderThreeStageReport(report)
  assert.ok(md.includes('Stage 1'))
  assert.ok(md.includes('Stage 2'))
  assert.ok(md.includes('Stage 3'))

  console.log('ANCHORS TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
