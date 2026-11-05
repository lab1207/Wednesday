/**
 * Offline test for the scoreboard page generator. No network, no model:
 * synthetic batch dirs in temp render all four board sections, Factory
 * rows, anchor rows, and history — with HTML-escaped content.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderScoreboard } from './scoreboard'

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'scoreboard-'))
  try {
    const batch = join(home, 'humaneval', '2026-01-01T00-00-00-000Z-ab12')
    await mkdir(batch, { recursive: true })
    await writeFile(join(batch, 'summary.json'), JSON.stringify({
      board: 'humaneval',
      mode: 'live',
      runnerVersion: 'public-v1.0.0',
      total: 5,
      passed: 4,
      passRate: 0.8,
      totalTokens: 1000,
      durationMs: 60000,
      datasetPath: 'x',
      batchDir: batch,
      model: 'qwen2.5-coder-3b-instruct',
    }), 'utf8')
    await writeFile(join(batch, 'records.jsonl'), '{"boardGrade":{"passed":true}}\n', 'utf8')

    const html = await renderScoreboard(home, '2026-01-01T00:00:00Z')
    assert.ok(html.includes('Python function writing'))
    assert.ok(html.includes('Fixing existing code'))
    assert.ok(html.includes('Competition problems'))
    assert.ok(html.includes('GitHub issue fixes'))
    assert.ok(html.includes('Wednesday'), 'ours column present')
    assert.ok(html.includes('live runs'), 'ours sublabel present')
    assert.ok(html.includes('<svg'), 'charts rendered')
    assert.ok(html.includes('80.0'), 'factory score rendered')
    assert.ok(html.includes('84.1'), 'official anchor rendered')
    assert.ok(html.includes('92.7'), 'ceiling rendered')
    assert.ok(html.includes('How to read this'), 'honesty section present')
    assert.ok(html.includes('2026-01-01T00:00:00Z'), 'generation stamp present')
    assert.ok(html.includes('<link rel="stylesheet"'), 'shared stylesheet linked')
    assert.ok(!html.includes('<style>'), 'no pasted style blocks')
    assert.ok(html.includes('#f0b429'), 'light theme accent present')
    assert.ok(!html.includes('#0d1117'), 'dark theme gone from markup')
    assert.ok(html.includes('table-wrap'), 'light card structure present')
    assert.ok(html.includes('<th>Time</th>'), 'run time column present')
    assert.ok(html.includes('1m 0s'), 'duration rendered humanly')
    assert.ok(html.includes('Model under test'), 'model card present')
    assert.ok(!html.includes('2026-01-01T00-00-00-000Z-ab12'), 'raw batch ids hidden from cells')

    // Pre-model-label live batches backfill the single known live model
    // (public-v1.0.0 wrote no model field): the winner must not land in
    // 'unknown' and the model page must keep the score.
    const legacy = join(home, 'humaneval', '2026-01-01T00-00-00-000Z-legacy')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'summary.json'), JSON.stringify({
      board: 'humaneval',
      mode: 'live',
      runnerVersion: 'public-v1.0.0',
      total: 5,
      passed: 4,
      passRate: 0.8,
      totalTokens: 1000,
      durationMs: 60000,
      datasetPath: 'x',
      batchDir: legacy,
    }), 'utf8')
    await writeFile(join(legacy, 'records.jsonl'), '{"boardGrade":{"passed":true}}\n', 'utf8')
    const legacyHtml = await renderScoreboard(home, '2026-01-01T00:00:00Z', 'qwen2.5-coder-3b-instruct')
    assert.ok(legacyHtml.includes('80.0'), 'backfilled legacy batch keeps the score on the model page')

    // Model library: slug, filtered page, index.
    const { modelSlug, libraryMetadata, renderLibraryIndex, CREWS, renderCrewPage } = await import('./scoreboard')
    assert.equal(modelSlug('Qwen2.5-Coder-3B-Instruct'), 'qwen2-5-coder-3b-instruct')
    const filtered = await renderScoreboard(home, '2026-01-01T00:00:00Z', 'deterministic')
    assert.ok(filtered.includes('Wednesday × deterministic'), 'filtered page titles the model')
    const meta = libraryMetadata('Qwen2.5-Coder-3B-Instruct', [], '2026-01-01T00:00:00Z')
    assert.equal(meta.slug, 'qwen2-5-coder-3b-instruct')
    const index = renderLibraryIndex([meta])
    assert.ok(index.includes('qwen2-5-coder-3b-instruct.html'), 'index links the model page')
    assert.ok(index.includes('Tested models'), 'index titles the library')
    const filteredQwen = await renderScoreboard(home, '2026-01-01T00:00:00Z', 'qwen2.5-coder-3b-instruct')
    assert.ok(filteredQwen.includes('qwen2.5-coder-3b-instruct'), 'filtered page names the model')
    assert.ok(filteredQwen.includes('80.0'), 'filtered page keeps the score')

    // Crew pages: roster + roles + config, never per-member scores.
    assert.ok(CREWS.length >= 1, 'crew catalog non-empty')
    const crew = CREWS[0]
    assert.equal(crew.slug, 'crew-1')
    assert.equal(crew.members.length, 3, 'trio roster')
    const crewHtml = renderCrewPage(crew, '2026-01-01T00:00:00Z')
    for (const member of crew.members) {
      assert.ok(crewHtml.includes(member.model), `crew page names ${member.model}`)
      assert.ok(crewHtml.includes(member.role), 'crew page states the role')
    }
    assert.ok(crewHtml.includes('No per-member scores'), 'honesty boundary stated')
    assert.ok(!crewHtml.includes('80.0'), 'no fabricated member numbers')
    const crewIndex = renderLibraryIndex([meta])
    assert.ok(crewIndex.includes('Crews'), 'index sections crews first')
    assert.ok(crewIndex.includes('crew-1.html'), 'index links the crew page')
    assert.ok(crewIndex.indexOf('Crews') < crewIndex.indexOf('Models'), 'crews outrank lone models')
    console.log('SCOREBOARD TEST: PASS')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
