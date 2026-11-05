/**
 * Published anchors for the public-benchmark head-to-head (user direction 2026-09-21).
 *
 * We NEVER re-run big models through the Factory. This file writes down the
 * official Qwen2.5-Coder-3B-Instruct numbers so every Factory run can report:
 *   3B raw (official) vs 3B repro (third-party harness) vs 3B + Factory (our runs)
 * with big-model published numbers as ceiling rows.
 *
 * Sources (all public, no re-run):
 * - OFFICIAL: Qwen2.5-Coder Technical Report arXiv:2409.12186v3
 *   Table 16 (code generation) + Table 19 (Aider code editing).
 * - REPRO: QwenLM/Qwen3-Coder issue #420 (OpenCompass harness):
 *   3B-Instruct HumanEval 45.12 / MBPP 30.20 — harness-sensitive gap.
 * - CEILING: same report tables (32B-Instruct) + closed APIs from Table 16/19.
 *
 * Harness honesty: official Qwen numbers use the Qwen EvalPlus harness;
 * repro uses OpenCompass; OUR runs grade solution.py with the board's own
 * check() asserts (factory/benchmark/public/humaneval.ts). Same board,
 * different harness — deltas are directional, not lab-exact.
 */

export type PublicBoardId = 'humaneval' | 'aider' | 'livecodebench' | 'swebench' | 'swe-bench-lite'

export interface AnchorRow {
  readonly board: PublicBoardId
  /** e.g. 'qwen2.5-coder-3b-instruct', 'qwen2.5-coder-32b-instruct', 'gpt-4o-2024-08-06' */
  readonly model: string
  /** e.g. 'HumanEval HE pass@1', 'Aider Pass@1' */
  readonly metric: string
  /** 0..1 pass rate. */
  readonly score: number
  readonly source: string
  readonly notes?: string
}

/** Official 3B-Instruct numbers (the "raw" row the Factory must lift). */
export const QWEN_3B_OFFICIAL: AnchorRow[] = [
  { board: 'humaneval', model: 'qwen2.5-coder-3b-instruct', metric: 'HumanEval HE pass@1', score: 0.841, source: 'Qwen2.5-Coder Tech Report Table 16 (arXiv:2409.12186v3)' },
  { board: 'humaneval', model: 'qwen2.5-coder-3b-instruct', metric: 'HumanEval HE+ pass@1', score: 0.805, source: 'Qwen2.5-Coder Tech Report Table 16 (arXiv:2409.12186v3)' },
  { board: 'aider', model: 'qwen2.5-coder-3b-instruct', metric: 'Aider Pass@1', score: 0.338, source: 'Qwen2.5-Coder Tech Report Table 19 (arXiv:2409.12186v3)' },
  { board: 'aider', model: 'qwen2.5-coder-3b-instruct', metric: 'Aider Pass@2', score: 0.391, source: 'Qwen2.5-Coder Tech Report Table 19 (arXiv:2409.12186v3)' },
  { board: 'livecodebench', model: 'qwen2.5-coder-3b-instruct', metric: 'LiveCodeBench Pass@1', score: 0.108, source: 'Qwen2.5-Coder Tech Report Table 16 (arXiv:2409.12186v3)' },
]

/** Third-party reproduction (same model, different harness — the gap under test). */
export const QWEN_3B_REPRO: AnchorRow[] = [
  { board: 'humaneval', model: 'qwen2.5-coder-3b-instruct', metric: 'HumanEval pass@1', score: 0.4512, source: 'QwenLM/Qwen3-Coder issue #420 (OpenCompass)', notes: 'MBPP repro 30.20 on same harness' },
]

/** Ceiling rows: what "frontier-grade" means per board (published, never re-run). */
export const CEILING_ANCHORS: AnchorRow[] = [
  { board: 'humaneval', model: 'qwen2.5-coder-32b-instruct', metric: 'HumanEval HE pass@1', score: 0.927, source: 'Qwen2.5-Coder Tech Report Table 16' },
  { board: 'humaneval', model: 'gpt-4o-2024-08-06', metric: 'HumanEval HE pass@1', score: 0.921, source: 'Qwen2.5-Coder Tech Report Table 16' },
  { board: 'aider', model: 'qwen2.5-coder-32b-instruct', metric: 'Aider Pass@1', score: 0.609, source: 'Qwen2.5-Coder Tech Report Table 19' },
  { board: 'aider', model: 'qwen2.5-coder-32b-instruct', metric: 'Aider Pass@2', score: 0.737, source: 'Qwen2.5-Coder Tech Report Table 19' },
  { board: 'aider', model: 'gpt-4o-2024-08-06', metric: 'Aider Pass@1', score: 0.568, source: 'Qwen2.5-Coder Tech Report Table 19' },
  { board: 'livecodebench', model: 'qwen2.5-coder-32b-instruct', metric: 'LiveCodeBench Pass@1', score: 0.314, source: 'Qwen2.5-Coder Tech Report Table 16' },
  { board: 'livecodebench', model: 'gpt-4o-2024-08-06', metric: 'LiveCodeBench Pass@1', score: 0.346, source: 'Qwen2.5-Coder Tech Report Table 16' },
]

/**
 * Stage 3 market rows: similar / competing models on the SAME metric,
 * same report tables (never re-run). Answers "where does 3B+Factory stand".
 */
export const MARKET_ANCHORS: AnchorRow[] = [
  { board: 'humaneval', model: 'ds-coder-1.3b-instruct', metric: 'HumanEval HE pass@1', score: 0.659, source: 'Qwen2.5-Coder Tech Report Table 16' },
  { board: 'humaneval', model: 'yi-coder-1.5b-chat', metric: 'HumanEval HE pass@1', score: 0.695, source: 'Qwen2.5-Coder Tech Report Table 16' },
  { board: 'humaneval', model: 'qwen2.5-coder-1.5b-instruct', metric: 'HumanEval HE pass@1', score: 0.707, source: 'Qwen2.5-Coder Tech Report Table 16' },
  { board: 'humaneval', model: 'ds-coder-6.7b-instruct', metric: 'HumanEval HE pass@1', score: 0.744, source: 'Qwen2.5-Coder Tech Report Table 16' },
  { board: 'humaneval', model: 'qwen2.5-coder-7b-instruct', metric: 'HumanEval HE pass@1', score: 0.884, source: 'Qwen2.5-Coder Tech Report Table 16' },
  { board: 'aider', model: 'ds-coder-1.3b-instruct', metric: 'Aider Pass@1', score: 0.18, source: 'Qwen2.5-Coder Tech Report Table 19' },
  { board: 'aider', model: 'yi-coder-1.5b-chat', metric: 'Aider Pass@1', score: 0.173, source: 'Qwen2.5-Coder Tech Report Table 19' },
  { board: 'aider', model: 'qwen2.5-coder-1.5b-instruct', metric: 'Aider Pass@1', score: 0.286, source: 'Qwen2.5-Coder Tech Report Table 19' },
  { board: 'aider', model: 'ds-coder-6.7b-instruct', metric: 'Aider Pass@1', score: 0.376, source: 'Qwen2.5-Coder Tech Report Table 19' },
  { board: 'aider', model: 'qwen2.5-coder-7b-instruct', metric: 'Aider Pass@1', score: 0.556, source: 'Qwen2.5-Coder Tech Report Table 19' },
  { board: 'livecodebench', model: 'ds-coder-1.3b-instruct', metric: 'LiveCodeBench Pass@1', score: 0.051, source: 'Qwen2.5-Coder Tech Report Table 16' },
  { board: 'livecodebench', model: 'yi-coder-1.5b-chat', metric: 'LiveCodeBench Pass@1', score: 0.048, source: 'Qwen2.5-Coder Tech Report Table 16' },
  { board: 'livecodebench', model: 'qwen2.5-coder-1.5b-instruct', metric: 'LiveCodeBench Pass@1', score: 0.061, source: 'Qwen2.5-Coder Tech Report Table 16' },
  { board: 'livecodebench', model: 'ds-coder-6.7b-instruct', metric: 'LiveCodeBench Pass@1', score: 0.155, source: 'Qwen2.5-Coder Tech Report Table 16' },
  { board: 'livecodebench', model: 'qwen2.5-coder-7b-instruct', metric: 'LiveCodeBench Pass@1', score: 0.182, source: 'Qwen2.5-Coder Tech Report Table 16' },
]

export interface FactoryComparison {
  readonly board: PublicBoardId
  /** Our measured pass rate 0..1. */
  readonly factoryScore: number
  readonly rawOfficial: number | null
  readonly repro: number | null
  /** factory - rawOfficial in percentage points (null when no official anchor). */
  readonly liftOverOfficialPp: number | null
  /** factory - repro in percentage points (null when no repro anchor). */
  readonly liftOverReproPp: number | null
  /** Ceiling rows on the same board for head-to-head reading. */
  readonly ceilings: AnchorRow[]
}

/**
 * Compare one Factory board result against the written-down anchors.
 * Pure function — no I/O, offline-safe.
 */
export function compareFactoryVsAnchors(
  board: PublicBoardId,
  factoryScore: number,
  metricMatch?: string,
): FactoryComparison {
  const official = QWEN_3B_OFFICIAL.filter(r => r.board === board)
  const raw = metricMatch
    ? (official.find(r => r.metric === metricMatch) ?? official[0] ?? null)
    : (official[0] ?? null)
  const repro = QWEN_3B_REPRO.find(r => r.board === board) ?? null
  return {
    board,
    factoryScore,
    rawOfficial: raw?.score ?? null,
    repro: repro?.score ?? null,
    liftOverOfficialPp:
      raw ? Math.round((factoryScore - raw.score) * 1000) / 10 : null,
    liftOverReproPp:
      repro ? Math.round((factoryScore - repro.score) * 1000) / 10 : null,
    ceilings: CEILING_ANCHORS.filter(r => r.board === board),
  }
}

/** One markdown table row per comparison — the "what grade did Factory produce" line. */
export function renderComparisonRow(c: FactoryComparison): string {
  const pct = (x: number | null): string => (x === null ? '-' : `${(x * 100).toFixed(1)}%`)
  const pp = (x: number | null): string =>
    x === null ? '-' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}pp`
  const ceiling = c.ceilings.length > 0
    ? c.ceilings.map(r => `${r.model} ${pct(r.score)}`).join('; ')
    : '-'
  return `| ${c.board} | ${pct(c.factoryScore)} (3B+Factory) | ${pct(c.rawOfficial)} (3B official) | ${pct(c.repro)} (3B repro) | ${pp(c.liftOverOfficialPp)} | ${pp(c.liftOverReproPp)} | ${ceiling} |`
}

export const COMPARISON_HEADER =
  '| Board | Factory | Raw official | Repro | Lift vs official | Lift vs repro | Ceilings (published) |'

// ---------------------------------------------------------------------------
// 3-stage evaluation pipeline (user wording, 2026-09-21):
// Stage 1 Official Baseline -> Stage 2 Factory Generation & Verification ->
// Stage 3 Market Benchmarking. Pure functions, offline-safe. The live
// Factory score is produced by run-board.ts; these helpers only compare it.
// ---------------------------------------------------------------------------

export interface Stage1Baseline {
  readonly board: PublicBoardId
  readonly model: string
  readonly rows: AnchorRow[]
}

export interface Stage2Verification {
  readonly board: PublicBoardId
  readonly factoryScore: number
  readonly officialScore: number | null
  readonly reproScore: number | null
  readonly deltaOfficialPp: number | null
  readonly deltaReproPp: number | null
  /** Informational only: harnesses differ, so a gap is expected. */
  readonly harnessNote: string
}

export interface Stage3Standing {
  readonly board: PublicBoardId
  readonly factoryScore: number
  /** Factory ranked against market + ceiling rows, best first. */
  readonly ranked: Array<{ model: string; score: number; deltaPp: number }>
  readonly rank: number
  readonly total: number
}

export interface ThreeStageReport {
  readonly stage1: Stage1Baseline
  readonly stage2: Stage2Verification
  readonly stage3: Stage3Standing
}

/** Stage 1: record the official published metrics for Model 1. */
export function stage1Baseline(
  board: PublicBoardId,
  model = 'qwen2.5-coder-3b-instruct',
): Stage1Baseline {
  return {
    board,
    model,
    rows: QWEN_3B_OFFICIAL.filter(r => r.board === board && r.model === model),
  }
}

/** Stage 2: Factory score vs official — validates harness consistency, tracks delta. */
export function stage2Verify(
  board: PublicBoardId,
  factoryScore: number,
  metricMatch?: string,
): Stage2Verification {
  const c = compareFactoryVsAnchors(board, factoryScore, metricMatch)
  return {
    board,
    factoryScore,
    officialScore: c.rawOfficial,
    reproScore: c.repro,
    deltaOfficialPp: c.liftOverOfficialPp,
    deltaReproPp: c.liftOverReproPp,
    harnessNote:
      'Official=Qwen EvalPlus harness; repro=OpenCompass; factory=board check() on solution.py. ' +
      'A gap validates harness difference, not Factory failure — compare vs repro too.',
  }
}

/** Stage 3: rank the Factory score against similar market models + ceilings. */
export function stage3Market(
  board: PublicBoardId,
  factoryScore: number,
): Stage3Standing {
  const market = MARKET_ANCHORS.filter(r => r.board === board)
  const ceilings = CEILING_ANCHORS.filter(r => r.board === board)
  const entries = [
    { model: 'qwen2.5-coder-3b-instruct+factory (ours)', score: factoryScore },
    ...market.map(r => ({ model: `${r.model} (published)`, score: r.score })),
    ...ceilings.map(r => ({ model: `${r.model} (ceiling)`, score: r.score })),
  ]
  const ranked = entries
    .map(e => ({
      model: e.model,
      score: e.score,
      deltaPp: Math.round((factoryScore - e.score) * 1000) / 10,
    }))
    .sort((a, b) => b.score - a.score)
  const rank = ranked.findIndex(r => r.model.startsWith('qwen2.5-coder-3b-instruct+factory')) + 1
  return { board, factoryScore, ranked, rank, total: ranked.length }
}

/** Full 3-stage workflow in one call. */
export function runThreeStageEvaluation(
  board: PublicBoardId,
  factoryScore: number,
  metricMatch?: string,
): ThreeStageReport {
  return {
    stage1: stage1Baseline(board),
    stage2: stage2Verify(board, factoryScore, metricMatch),
    stage3: stage3Market(board, factoryScore),
  }
}

/** Markdown rendering of the 3-stage report. */
export function renderThreeStageReport(r: ThreeStageReport): string {
  const pct = (x: number | null): string => (x === null ? '-' : `${(x * 100).toFixed(1)}%`)
  const pp = (x: number | null): string =>
    x === null ? '-' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}pp`
  const lines = [
    `## 3-stage evaluation: ${r.stage1.board} (qwen2.5-coder-3b-instruct)`,
    '',
    `Stage 1 — Official baseline: ${r.stage1.rows.map(a => `${a.metric} ${pct(a.score)}`).join('; ') || '-'}`,
    `Stage 2 — Factory verification: factory ${pct(r.stage2.factoryScore)} vs official ${pct(r.stage2.officialScore)} (${pp(r.stage2.deltaOfficialPp)}) / vs repro ${pct(r.stage2.reproScore)} (${pp(r.stage2.deltaReproPp)}). ${r.stage2.harnessNote}`,
    `Stage 3 — Market standing: rank ${r.stage3.rank}/${r.stage3.total} on ${r.stage3.board}.`,
    ...r.stage3.ranked.map(e => `- ${e.model}: ${pct(e.score)} (${pp(e.deltaPp)} vs factory)`),
  ]
  return lines.join('\n')
}
