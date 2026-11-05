/**
 * Solo tryout gate (2026-10-13): one model runs solo-with-Factory on a
 * fixed sample; numbers decide team membership. Pure, offline-green.
 *
 * Admit (default line, operator-tunable via env):
 * - passRate >= FACTORY_TRYOUT_MIN_PASS (default 0.5)
 * - reviewerPass >= FACTORY_TRYOUT_MIN_REVIEW (default 0.5)
 * Repair convergence is reported, never gating: a model that solves
 * cleanly and one that solves via repairs both ship — flailing
 * (repairs never help) only warns. Zero evidence always mutes.
 */

export interface TryoutStats {
  solved: number
  total: number
  repairsHelped: number
  repairsTotal: number
  reviewerPass: number
  reviewerTotal: number
}

export interface TryoutThresholds {
  minPass: number
  minReview: number
}

export function tryoutThresholds(
  env: NodeJS.ProcessEnv = process.env,
): TryoutThresholds {
  const num = (raw: string | undefined, fallback: number): number => {
    const trimmed = (raw ?? '').trim()
    if (!trimmed) return fallback
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
      ? parsed
      : fallback
  }
  return {
    minPass: num(env.FACTORY_TRYOUT_MIN_PASS, 0.5),
    minReview: num(env.FACTORY_TRYOUT_MIN_REVIEW, 0.5),
  }
}

export interface TryoutVerdict {
  admitted: boolean
  passRate: number
  reviewerRate: number
  repairHelpRate: number
  reasons: string[]
}

export function qualifyForTeam(
  stats: TryoutStats,
  thresholds: TryoutThresholds = tryoutThresholds(),
): TryoutVerdict {
  const reasons: string[] = []
  if (stats.total <= 0) {
    return {
      admitted: false,
      passRate: 0,
      reviewerRate: 0,
      repairHelpRate: 0,
      reasons: ['mute: no evidence, tryout never ran'],
    }
  }
  const passRate = stats.solved / stats.total
  const reviewerRate =
    stats.reviewerTotal > 0 ? stats.reviewerPass / stats.reviewerTotal : 0
  const repairHelpRate =
    stats.repairsTotal > 0 ? stats.repairsHelped / stats.repairsTotal : 0
  reasons.push(
    `pass ${stats.solved}/${stats.total} (${passRate.toFixed(2)} vs ${thresholds.minPass})`,
  )
  reasons.push(
    `review ${stats.reviewerPass}/${stats.reviewerTotal} (${reviewerRate.toFixed(2)} vs ${thresholds.minReview})`,
  )
  reasons.push(
    stats.repairsTotal > 0
      ? `repairs helped ${stats.repairsHelped}/${stats.repairsTotal} (${repairHelpRate.toFixed(2)}, reported not gating)`
      : 'no repairs needed (clean solves)',
  )
  const admitted =
    passRate >= thresholds.minPass && reviewerRate >= thresholds.minReview
  reasons.push(admitted ? 'ADMIT: above the line on pass + review' : 'MUTE: below the line, evidence kept for re-try')
  return { admitted, passRate, reviewerRate, repairHelpRate, reasons }
}
